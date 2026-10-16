import {
  businessBudget,
  CASE_MAX_MS,
  compileStepBudget,
  type VerificationTask,
} from '@proofrun/contracts';
import { ApiError } from '../../domain.js';

/** 重跑只扩展时间；动作、模型请求次数与收尾额度沿用所选预算策略。 */
export interface RerunTimeBudget {
  /** 每个业务步骤的最低总时长，包含该步骤声明的等待。 */
  stepTimeoutMs?: number;
  /** 整段清理的最低总时长，多个清理步骤共享。 */
  cleanupTimeoutMs?: number;
}

/** 严格限制公开输入，拒绝拼错字段或无效数值，避免预算静默不生效。 */
export function parseRerunTimeBudget(
  input: unknown,
): RerunTimeBudget | undefined {
  if (input === undefined) return undefined;
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !Object.keys(input).length ||
    Object.entries(input).some(
      ([key, value]) =>
        !['stepTimeoutMs', 'cleanupTimeoutMs'].includes(key) ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > CASE_MAX_MS,
    )
  )
    throw new ApiError(
      400,
      'INVALID_RERUN',
      'timeBudget 只接受正整数毫秒的 stepTimeoutMs 或 cleanupTimeoutMs',
    );
  return input as RerunTimeBudget;
}

/** 仅修改新编译的任务；保留更长的原步骤，重新汇总业务时间并检查完整会话上限。 */
export function extendRerunTimeBudget(
  task: VerificationTask,
  time: RerunTimeBudget,
): void {
  const plan = structuredClone(task.stepBudget ?? compileStepBudget(task));
  for (const step of plan.steps)
    step.timeoutMs = Math.max(step.timeoutMs, time.stepTimeoutMs ?? 0);
  plan.cleanup.timeoutMs = Math.max(
    plan.cleanup.timeoutMs,
    time.cleanupTimeoutMs ?? 0,
  );
  const budget = businessBudget(plan);
  const preparationMs =
    task.sessionPlan?.candidates.length || task.sessionPlan?.library
      ? task.sessionPlan.preparationMs
      : 0;
  if (
    budget.timeoutMs +
      preparationMs +
      plan.settleMs * plan.steps.length +
      (task.cleanupStepIds?.length ? plan.cleanup.timeoutMs : 0) >
    CASE_MAX_MS
  )
    throw new ApiError(
      422,
      'CASE_BUDGET_EXCEEDED',
      '重跑所需时间超过平台会话上限，请拆分 case',
    );
  task.stepBudget = plan;
  // 原历史动作总额可能与逐步合计不同，时间覆盖不能顺便改变它。
  task.budget = { ...task.budget, timeoutMs: budget.timeoutMs };
}
