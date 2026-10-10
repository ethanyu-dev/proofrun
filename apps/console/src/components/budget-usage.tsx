import type { StepResult, VerificationTask } from '@proofrun/contracts';

/** 用量与限额并列，旧报告没有用量时不伪造零值。 */
export function BudgetUsage({ usage }: { usage?: StepResult['budgetUsage'] }) {
  if (!usage) return null;
  return (
    <p className="muted budget-usage">
      模型 {usage.modelCalls}/{usage.limit.maxModelCalls} · 动作 {usage.actions}
      /{usage.limit.maxActions}
      <br />
      耗时 {Math.ceil(usage.elapsedMs / 1000)}/
      {Math.ceil(usage.limit.timeoutMs / 1000)} 秒
    </p>
  );
}

/** 业务与清理分别汇总，清理的额度只计一次，不随清理步骤数量扩大。 */
export function BudgetTotal({
  task,
  results,
  cleanup = false,
}: {
  task: VerificationTask;
  results: StepResult[];
  cleanup?: boolean;
}) {
  const plan = task.stepBudget;
  if (!plan) return null;
  const selected = results.filter(
    (step) => Boolean(task.cleanupStepIds?.includes(step.stepId)) === cleanup,
  );
  const used = selected.reduce(
    (sum, step) => ({
      actions: sum.actions + (step.budgetUsage?.actions ?? 0),
      modelCalls: sum.modelCalls + (step.budgetUsage?.modelCalls ?? 0),
      elapsedMs: sum.elapsedMs + (step.budgetUsage?.elapsedMs ?? 0),
    }),
    { actions: 0, modelCalls: 0, elapsedMs: 0 },
  );
  const limit = cleanup
    ? plan.cleanup
    : plan.steps.reduce(
        (sum, step) => ({
          timeoutMs: sum.timeoutMs + step.timeoutMs,
          maxActions: sum.maxActions + step.maxActions,
          maxModelCalls: sum.maxModelCalls + step.maxModelCalls,
        }),
        { timeoutMs: 0, maxActions: 0, maxModelCalls: 0 },
      );
  return (
    <div className="budget-total">
      <span className="muted">
        {cleanup
          ? '清理独立预算（整段共享）'
          : '业务预算（逐步独立，不互相借用）'}
      </span>
      {selected.some((step) => step.budgetUsage) ? (
        <BudgetUsage usage={{ ...used, limit }} />
      ) : (
        <p className="muted">
          额度：模型 {limit.maxModelCalls} 次 · 动作 {limit.maxActions} 次 ·{' '}
          {Math.ceil(limit.timeoutMs / 1000)} 秒；尚无用量记录
        </p>
      )}
    </div>
  );
}
