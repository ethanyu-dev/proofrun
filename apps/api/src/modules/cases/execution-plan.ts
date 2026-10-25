import type { VerificationCaseV2, VerificationTask } from '@proofrun/contracts';
import { ApiError } from '../../domain.js';

/** 只识别原始准备指令中的明确访客要求；页面内容和预期文案不参与身份选择。 */
const GUEST =
  /(?:保持|确保|确认|以|使用|当前为|全程|处于|为)\s*(?:未登录|访客)|清除(?:\s*token\s*等)?登录态|退出登录|^(?:未登录|访客模式|访客状态)|\b(?:as (?:an? )?(?:unauthenticated user|guest)|remain logged out|clear (?:the )?login state)\b/iu;
/** 否定、条件句或引用中的身份描述不能作为自动环境准备的授权。 */
const AMBIGUOUS =
  /不要|不得|无需|不需要|如果|若|假如|例如|示例|是否|[「」“”"`]|\b(?:if|unless|example|do not|must not)\b/iu;
/** 只识别原始操作和前置条件中的登录或账号身份要求；登录页、按钮及验收文案不触发取账号。 */
const LOGIN_REQUIRED =
  /已登录|登录后|完成登录|进行登录|需要登录|必须登录|^(?:登录|登入)(?:系统|网站|平台|后台|控制台|$)|账号.{0,40}登录|账户.{0,40}登录|登录.{0,20}(?:账号|账户)|(?:账号|账户)(?:必须|应|需|为|是|属于)|(?:使用|以).{0,32}(?:身份|账号|账户)|\b(?:logged[ -]?in|must (?:log|sign) in|(?:log|sign) in (?:to|with))\b/iu;
/** 否定登录与登录界面检查不得被提升为登录授权。 */
const LOGIN_EXCLUDED =
  /未登录|不登录|无需登录|不需要登录|退出登录|访客|\b(?:guest|logged[ -]?out|(?:check|verify|inspect|test) (?:the )?(?:login|sign in|log in) (?:page|button|form))\b/iu;

/** 只从原始操作或前置条件识别确定需求；否定、条件句和界面文案检查留给执行阶段核验。 */
function needsAccount(text: string): boolean {
  return (
    LOGIN_REQUIRED.test(text) &&
    !LOGIN_EXCLUDED.test(text) &&
    !AMBIGUOUS.test(text)
  );
}

/** 会话创建前解析环境并冻结证据并集；原始业务定义保持不变。 */
export function resolveExecutionPlan(
  input: VerificationCaseV2,
  evidenceKinds: VerificationTask['acceptanceCriteria'][number]['evidenceKinds'],
): {
  plan: NonNullable<VerificationTask['executionPlan']>;
  session: NonNullable<VerificationCaseV2['session']>;
  automatic?: { loginRequired: boolean };
} {
  const instructions = input.steps
    .filter((step) => step.type === 'setup')
    .flatMap((step) => [step.description, ...step.policy]);
  const guest = instructions.filter(
    (text) => GUEST.test(text) && !AMBIGUOUS.test(text),
  );
  const authenticated = instructions.filter(needsAccount);
  const automatic = !input.session || input.session.mode === 'auto';
  const explicit = automatic ? undefined : input.session?.mode;
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
  // 自动会话只有明确登录需求才进入账号准备；普通页面检查固定使用访客环境。
  const loginRequired =
    !!input.session?.external ||
    !!input.session?.requirements?.length ||
    input.steps.some((step) =>
      [
        step.description,
        ...step.policy,
        ...(step.preconditions ?? []).map((check) => check.description),
      ].some(needsAccount),
    );
  const mode =
    explicit === 'guest' || (!explicit && (guest.length || !loginRequired))
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
    session: automatic
      ? {
          mode:
            mode === 'guest'
              ? 'guest'
              : input.session?.external
                ? 'external'
                : 'manual',
          requirements: input.session?.requirements ?? [],
          ...(mode !== 'guest' && input.session?.external
            ? { external: input.session.external }
            : {}),
        }
      : input.session!,
    ...(automatic
      ? {
          automatic: {
            loginRequired: mode !== 'guest' && loginRequired,
          },
        }
      : {}),
  };
}
