import { compileStepBudget, type VerificationTask } from '@proofrun/contracts';
import { ApiError } from '../../domain.js';
import { useManualSession } from './automatic.js';
import {
  ACCOUNT_HUMAN_MARGIN_MS,
  ACCOUNT_CLOSE_MARGIN_MS,
  ACCOUNT_MAX_SECONDS,
} from '../account-providers/policy.js';

/** 按最终执行预算冻结外部账号租期；重跑覆盖原预算或扩容后必须重新计算，避免租约先于步骤到期。 */
export function refreshExternalSessionBudget(task: VerificationTask): void {
  const session = task.sessionPlan;
  if (!session?.external) return;
  const plan = task.stepBudget ?? compileStepBudget(task);
  const duration = Math.ceil(
    (task.budget.timeoutMs +
      session.preparationMs +
      plan.settleMs * plan.steps.length +
      (task.cleanupStepIds?.length ? plan.cleanup.timeoutMs : 0) +
      ACCOUNT_HUMAN_MARGIN_MS +
      ACCOUNT_CLOSE_MARGIN_MS) /
      1000,
  );
  if (duration > ACCOUNT_MAX_SECONDS && session.automatic) {
    useManualSession(task, 'EXTERNAL_ACCOUNT_BUDGET');
    return;
  }
  if (duration > ACCOUNT_MAX_SECONDS)
    throw new ApiError(
      422,
      'EXTERNAL_ACCOUNT_BUDGET',
      '外部账号最长两小时，请拆分 Case',
    );
  session.external.durationSeconds = Math.max(60, duration);
}
