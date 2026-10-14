import type { VerificationCaseV2, VerificationTask } from '@proofrun/contracts';
import { ApiError } from '../../domain.js';

/** 只识别原始准备指令中的明确访客要求；页面内容和预期文案不参与身份选择。 */
const GUEST =
  /(?:保持|以|使用|当前为|全程|处于|为)\s*(?:未登录|访客)|清除(?:\s*token\s*等)?登录态|退出登录|^(?:未登录访客|访客模式)|\b(?:as (?:an? )?(?:unauthenticated user|guest)|remain logged out|clear (?:the )?login state)\b/iu;
/** 明确已登录要求与访客要求并存时不能自行决定先后或替换账号。 */
const AUTHENTICATED =
  /(?:保持|必须|要求|使用|以)\s*(?:已登录|登录后的)|(?:完成|进行)登录|\b(?:must be logged in|as an authenticated user)\b/iu;
/** 否定、条件句或引用中的身份描述不能作为自动环境准备的授权。 */
const AMBIGUOUS =
  /不要|不得|无需|不需要|如果|若|假如|例如|示例|是否|[「」“”"`]|\b(?:if|unless|example|do not|must not)\b/iu;

/** 会话创建前解析环境并冻结证据并集；原始业务定义保持不变。 */
export function resolveExecutionPlan(
  input: VerificationCaseV2,
  evidenceKinds: VerificationTask['acceptanceCriteria'][number]['evidenceKinds'],
): {
  plan: NonNullable<VerificationTask['executionPlan']>;
  session: NonNullable<VerificationCaseV2['session']>;
} {
  const instructions = input.steps
    .filter((step) => step.type === 'setup')
    .flatMap((step) => [step.description, ...step.policy]);
  const guest = instructions.filter(
    (text) => GUEST.test(text) && !AMBIGUOUS.test(text),
  );
  const authenticated = instructions.filter(
    (text) => AUTHENTICATED.test(text) && !AMBIGUOUS.test(text),
  );
  const explicit = input.session?.mode;
  if (
    (guest.length && authenticated.length) ||
    (guest.length && explicit && explicit !== 'guest') ||
    (authenticated.length && explicit === 'guest')
  )
    throw new ApiError(
      422,
      'ENVIRONMENT_CONFIG_CONFLICT',
      '访客要求与显式会话或其他准备要求冲突，请拆分 case 或调整 session',
    );
  const mode =
    explicit === 'guest' || (!explicit && guest.length)
      ? 'guest'
      : 'configured';
  const kinds = new Set(evidenceKinds);
  for (const step of [...input.steps, ...input.cleanup]) {
    const ids = new Set<string>();
    for (const check of step.policyChecks ?? []) {
      if (
        ids.has(check.id) ||
        check.policyIndex >= (step.policy?.length ?? 0) ||
        (check.method === 'networkResponse' &&
          check.statusMin! > check.statusMax!)
      )
        throw new ApiError(
          422,
          'INVALID_POLICY_CHECK',
          '条件 ID 必须唯一，policyIndex 必须指向原始 policy，状态码范围必须有效',
        );
      ids.add(check.id);
      kinds.add(check.method === 'networkResponse' ? 'NETWORK' : 'DOM');
    }
  }
  const plan: NonNullable<VerificationTask['executionPlan']> = {
    version: 1,
    environment: {
      mode,
      source: explicit ? 'explicit' : guest.length ? 'inferred' : 'default',
      basis: (guest.length ? guest : authenticated).slice(0, 64),
      resolverVersion: 1,
    },
    evidenceKinds: [...kinds],
  };
  return {
    plan,
    session: input.session ?? {
      mode: mode === 'guest' ? ('guest' as const) : ('manual' as const),
    },
  };
}
