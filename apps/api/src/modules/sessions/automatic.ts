import type { VerificationTask } from '@proofrun/contracts';

/** 自动取账号失败后仍必须确认登录，不能把身份前置条件静默改成访客。 */
const LOGIN_CONFIRMATION = 'automatic-login';

/** 只修改新运行的执行计划；原始 case、步骤、身份要求和历史运行保持原样。 */
export function useManualSession(task: VerificationTask, reason: string): void {
  const plan = task.sessionPlan!;
  if (!plan.automatic?.loginRequired || plan.automatic.fallbackReason) return;
  plan.mode = 'manual';
  delete plan.external;
  plan.automatic.fallbackReason = reason;
  const ids = new Set([
    ...plan.requirements.map((check) => check.id),
    ...(task.steps ?? []).flatMap((step) =>
      (step.preconditions ?? []).map((check) => check.id),
    ),
  ]);
  let id = LOGIN_CONFIRMATION;
  let suffix = 0;
  while (ids.has(id)) id = `${LOGIN_CONFIRMATION}-${++suffix}`;
  plan.requirements.push({
    id,
    method: 'manual',
    description:
      '请在当前会话完成登录，并确认账号满足本 case 原有身份与前置条件',
  });
}
