import type { VerificationTask, StepResult } from '@proofrun/contracts';
import {
  benchmarkContext,
  benchmarkToolBatchValid,
  type BenchmarkCase,
} from '@proofrun/contracts/benchmark';
import {
  V2_CONTEXT_CHARS,
  v2CallLimit,
} from '@proofrun/contracts/benchmark-scenarios';

/** 真实站点没有合成页面写入账本；根据冻结标准、真实步骤报告和逐轮原文严格判定。 */
export function archiveV2Checks(item: BenchmarkCase, row: any): void {
  const task = row.definition as VerificationTask;
  const steps = (row.step_results ?? []) as StepResult[];
  item.verification = {
    sourceTaskId: row.source.sourceTaskId,
    sourceCreatedAt: row.source.sourceCreatedAt,
    sourceDefinitionSha256: row.source.sourceDefinitionSha256,
    historicalVerdict: row.source.historicalVerdict,
    task,
    steps,
    report: row.report ?? null,
    sessionClosed: row.closure_verified === true,
  };
  const check = (name: string, passed: boolean, detail: string) =>
    item.checks.push({ name, passed, detail });
  check(
    '原任务全部验收项通过',
    row.report?.verdict === 'PASSED',
    `实际结论 ${item.verdict}；保持原验收标准`,
  );
  const complete = steps.filter((step) => step.status === 'COMPLETED').length;
  check(
    '原任务全部步骤与清理完成',
    steps.length === task.steps!.length &&
      new Set(steps.map((step) => step.stepId)).size === task.steps!.length &&
      task.steps!.every((expected) =>
        steps.some(
          (step) =>
            step.stepId === expected.stepId && step.status === 'COMPLETED',
        ),
      ),
    `${complete}/${task.steps!.length} 步完成；受阻或跳过仍不通过`,
  );
  const malformed = item.calls.find(
    (call) =>
      call.status !== 'RECEIVED' ||
      !task.steps!.some((step) => step.stepId === call.stepId) ||
      !benchmarkContext(call) ||
      benchmarkContext(call)!.total > V2_CONTEXT_CHARS ||
      !benchmarkToolBatchValid(call, true),
  );
  const perStep = task.stepBudget!.steps.every(
    (limit) =>
      item.calls.filter((call) => call.stepId === limit.stepId).length <=
      limit.maxModelCalls,
  );
  const cleanup =
    item.calls.filter((call) =>
      task.cleanupStepIds!.includes(call.stepId ?? ''),
    ).length <= task.stepBudget!.cleanup.maxModelCalls;
  check(
    '完整逐轮记录与原预算',
    item.calls.length > 0 &&
      item.calls.length <= v2CallLimit(task) &&
      new Set(item.calls.map((call) => call.callIndex)).size ===
        item.calls.length &&
      !malformed &&
      perStep &&
      cleanup,
    malformed
      ? `调用 ${malformed.callIndex} 的状态、步骤、context 或工具批次不合规`
      : `${item.calls.length}/${v2CallLimit(task)} 次请求；逐步与清理额度${perStep && cleanup ? '符合' : '超限'}`,
  );
}
