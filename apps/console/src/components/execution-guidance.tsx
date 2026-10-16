import { contextModules } from '../context-modules';

/** 事件来自执行器事实，不展示或推测模型隐藏推理。 */
const REASONS: Record<string, string> = {
  TASK_PROGRESS: '已有新证据，核对剩余要求',
  TARGET_LOCATED: '已观察到目标线索，核对是否进入交互',
  PLAN_REQUIRED: '需要确定当前子目标',
  PLAN_EXHAUSTED: '局部尝试额度已用完',
  STATE_CYCLE: '重复返回已访问状态',
  WORK_BUDGET_LOW: '剩余操作可能不足以完成当前目标',
  BUDGET_LOW: '动作、模型或时间预算较低',
};

/** 页面展示中文阶段名称，协议值留在原始上下文。 */
const PHASES: Record<string, string> = {
  locate: '定位',
  interact: '交互',
  collect: '取证',
  review: '复核',
};

/** 旧任务和正文已清理的调用不补造诊断。 */
export function guidanceSummary(request: Record<string, unknown>) {
  const value = contextModules(request).find((item) =>
    item.path.endsWith('.executionGuidance'),
  )?.value;
  if (!value || typeof value !== 'object') return null;
  const view = value as Record<string, unknown>;
  const plan = view.currentPlan as Record<string, unknown> | null;
  const budget = view.budget as Record<string, unknown> | undefined;
  return {
    version: String(view.version ?? '未记录'),
    goal: typeof plan?.goal === 'string' ? plan.goal : '尚未建立子目标',
    planId: String(plan?.id ?? '—'),
    phase: PHASES[String(plan?.phase)] ?? String(plan?.phase ?? '—'),
    remaining: String(plan?.remaining ?? '—'),
    review:
      typeof view.review === 'string'
        ? (REASONS[view.review] ?? view.review)
        : '沿用当前计划',
    estimate:
      typeof budget?.estimatedActions === 'number'
        ? `约 ${budget.estimatedActions} 次动作（不确定估算）`
        : '位置或路径不足，尚不可估算',
  };
}

/** 调用详情展示计划与复核原因，完整定位和事件记录仍在模块中展开。 */
export function ExecutionGuidanceSummary({
  request,
}: {
  request: Record<string, unknown>;
}) {
  const summary = guidanceSummary(request);
  if (!summary) return null;
  return (
    <section aria-label="执行诊断" className="context-module">
      <h3>当前执行目标</h3>
      <p>{summary.goal}</p>
      <p>
        阶段：{summary.phase} · 局部剩余：{summary.remaining} 次动作
      </p>
      <p>复核：{summary.review}</p>
      <p>剩余工作：{summary.estimate}</p>
      <p className="muted note">
        策略 {summary.version} · 计划 {summary.planId}。计划完成不代表验收通过。
      </p>
    </section>
  );
}
