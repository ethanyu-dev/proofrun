import type { IdentityCheck, VerificationTask } from '@proofrun/contracts';
import { permitsLoginRecovery } from './login-intervention.js';

/** 仅识别准备步骤明确描述的身份资格，不把“团队账户提示”等页面文案当成账号要求。 */
const ACCOUNT_QUALIFICATION =
  /团队子账号|团队成员|团队所有者|(?:账号|账户).{0,20}(?:角色|管理员)|(?:未|已)绑定\s*\S+|\b(?:team (?:member|owner|subaccount)|non[- ]owner|(?:not |un)?linked (?:to )?(?:github|google)|account role)\b/i;
/** 前置条件描述上限为 500；分段保留原文，不静默截断账号约束。 */
const DESCRIPTION_CHARS = 480;

/** 旧 Schema 未提供结构化身份检查时，将准备步骤原文交给人工确认；不从显示名推断资格。 */
export function legacyIdentityChecks(
  task: VerificationTask,
  stepIndex: number,
): IdentityCheck[] {
  const current = task.steps?.[stepIndex];
  if (
    !current ||
    !permitsLoginRecovery(task, stepIndex) ||
    current.preconditions?.length ||
    task.sessionPlan?.candidates[0]?.checks.length ||
    task.sessionPlan?.requirements.length
  )
    return [];
  const checks: IdentityCheck[] = [];
  // 沿用同站点最近一次身份准备；后续明确换账号时不能同时要求满足旧角色。
  for (let index = stepIndex; index >= 0; index--) {
    const step = task.steps![index]!;
    if (
      step.type !== 'setup' ||
      !permitsLoginRecovery(task, index) ||
      task.cleanupStepIds?.includes(step.stepId ?? '') ||
      new URL(step.url).origin !== new URL(current.url).origin
    )
      continue;
    if (step.preconditions?.length) return [];
    const requirements = [
      ...new Set([step.description, ...step.policy]),
    ].filter((text) => ACCOUNT_QUALIFICATION.test(text));
    for (const [requirement, text] of requirements.entries()) {
      for (let offset = 0; offset < text.length; offset += DESCRIPTION_CHARS)
        checks.push({
          id: `legacy-identity-${index}-${requirement}-${offset}`,
          description: text.slice(offset, offset + DESCRIPTION_CHARS),
          method: 'manual',
        });
    }
    if (checks.length) return checks;
  }
  return checks;
}
