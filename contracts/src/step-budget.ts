import type { VerificationTask } from './generated/verification-task.js';

/** 步骤基础额度为五分钟、十次动作、二十次模型请求；验证收尾单独增加。 */
export const STEP_LIMIT = {
  timeoutMs: 300_000,
  maxActions: 10,
  maxModelCalls: 20,
};
/** 验证项多的步骤需要逐项交互和取证；按结构化 expected 数量增加额度，不猜测自然语言复杂度。 */
const EXTRA_ACTIONS_PER_CRITERION = 2;
/** 验证在定位后仍须选择并查询结果；新任务预留两次收尾动作，不在执行中续费。 */
const VERIFICATION_COMPLETION_ACTIONS = 2;
/** 扩容仍有硬上限，循环检测与恢复次数不因额度变大而放宽。 */
const MAX_STEP_ACTIONS = 30;
/** 整段清理独立三分钟，不因清理步骤数量增加或人工等待而加时。 */
export const CLEANUP_LIMIT = { ...STEP_LIMIT, timeoutMs: 180_000 };
/** 只供在途命令、证据交付和结果落库收尾，不能用于发起新的业务操作。 */
export const STEP_SETTLE_MS = 120_000;
/** 非 setup 的纯等待只额外保留三十秒取证；setup 等待后仍须复核环境。 */
export const WAIT_EVIDENCE_MS = 30_000;
/** 硬上限约束整个会话；超过时应在提交阶段拒绝，不能截掉后续步骤额度。 */
export const CASE_MAX_MS = 86_400_000;
export const CASE_MAX_ACTIONS = 10_000;
export const CASE_MAX_MODEL_CALLS = 20_000;

export type StepBudgetPlan = NonNullable<VerificationTask['stepBudget']>;
export type StepLimit = StepBudgetPlan['cleanup'];

/** 只依据结构化定义编译预算；重试沿用已冻结的版本，各步骤分别计算。 */
export function compileStepBudget(
  task: Pick<VerificationTask, 'steps' | 'cleanupStepIds' | 'executionMode'>,
): StepBudgetPlan {
  return {
    version: 1,
    settleMs: STEP_SETTLE_MS,
    steps: (task.steps ?? [])
      .filter((step) => !task.cleanupStepIds?.includes(step.stepId!))
      .map((step) => {
        const actions =
          step.type === 'verification'
            ? Math.min(
                MAX_STEP_ACTIONS,
                STEP_LIMIT.maxActions +
                  VERIFICATION_COMPLETION_ACTIONS +
                  Math.max(0, step.expected.length - 1) *
                    EXTRA_ACTIONS_PER_CRITERION,
              )
            : STEP_LIMIT.maxActions;
        return {
          stepId: step.stepId!,
          timeoutMs:
            (step.wait?.durationMs ?? 0) +
            (step.wait && !step.expected.length && step.type !== 'setup'
              ? WAIT_EVIDENCE_MS
              : STEP_LIMIT.timeoutMs),
          maxActions:
            step.wait && !step.expected.length && step.type !== 'setup'
              ? 0
              : actions,
          maxModelCalls:
            step.wait && !step.expected.length && step.type !== 'setup'
              ? 0
              : Math.max(STEP_LIMIT.maxModelCalls, actions * 2),
        };
      }) as StepBudgetPlan['steps'],
    cleanup: {
      ...CLEANUP_LIMIT,
      maxModelCalls: CLEANUP_LIMIT.maxModelCalls,
    },
  };
}

/** 业务合计不包含清理；保留旧 budget 字段供展示与旧协议读取。 */
export function businessBudget(
  plan: StepBudgetPlan,
): VerificationTask['budget'] {
  return {
    timeoutMs: plan.steps.reduce((sum, step) => sum + step.timeoutMs, 0),
    maxActions: Math.max(
      1,
      plan.steps.reduce((sum, step) => sum + step.maxActions, 0),
    ),
  };
}

/** 节点必须覆盖业务、命令收尾和清理；人工等待仍依赖既有可续期会话能力。 */
export function sessionBudgetMs(task: VerificationTask): number {
  return (
    task.budget.timeoutMs +
    (task.sessionPlan?.candidates.length || task.sessionPlan?.external
      ? task.sessionPlan.preparationMs
      : 0) +
    (task.stepBudget?.settleMs ?? 0) * (task.stepBudget?.steps.length ?? 0) +
    (task.cleanupStepIds?.length
      ? (task.stepBudget?.cleanup.timeoutMs ?? CLEANUP_LIMIT.timeoutMs)
      : 0)
  );
}

/** 清理的多个步骤共享同一份限额，业务步骤只能使用自己的份额。 */
export function stepLimit(
  task: VerificationTask,
  stepId: string,
): StepLimit | undefined {
  return task.cleanupStepIds?.includes(stepId)
    ? task.stepBudget?.cleanup
    : task.stepBudget?.steps.find((step) => step.stepId === stepId);
}
