import type { RequestMetrics, VerificationReport } from '@proofrun/contracts';
import type { PoolClient } from 'pg';
import { addUsage, emptyUsage } from './usage.js';

/** 同一读取事务中汇总全部关联执行；复用只展示原执行事实，任务身份去重。 */
export async function requestMetrics(
  client: PoolClient,
  requestId: string,
  at: Date,
): Promise<RequestMetrics> {
  const tasks = (
    await client.query<{
      id: string;
      state: string;
      started_at: Date | null;
      finished_at: Date | null;
      details: VerificationReport['executionDetails'] | null;
    }>(
      `WITH members AS (SELECT task_id FROM pr_request_runs WHERE request_id=$1),
    ids AS (SELECT task_id FROM members UNION SELECT c.task_id FROM pr_case_cleanups c JOIN members m ON m.task_id=c.parent_task_id WHERE c.task_id IS NOT NULL)
    SELECT t.id,t.state,t.finished_at,e.created_at AS started_at,t.report->'executionDetails' AS details
    FROM ids JOIN pr_tasks t ON t.id=ids.task_id LEFT JOIN pr_executions e ON e.task_id=t.id WHERE t.deleted_at IS NULL`,
      [requestId],
    )
  ).rows;
  const calls = (
    await client.query<{
      task_id: string;
      prompt: number | null;
      completion: number | null;
    }>(
      `SELECT e.task_id,m.record->'promptTokens' AS prompt,m.record->'completionTokens' AS completion
    FROM pr_model_calls m JOIN pr_executions e ON e.id=m.execution_id WHERE e.task_id=ANY($1::text[])`,
      [tasks.map((task) => task.id)],
    )
  ).rows;
  const metrics: RequestMetrics = {
    executionElapsedMs: null,
    execution: emptyUsage(),
    llm: emptyUsage(),
    totalTokens: null,
  };
  for (const task of tasks) {
    const recorded = calls.filter((call) => call.task_id === task.id);
    if (recorded.length) {
      for (const call of recorded) {
        addUsage(metrics.execution, call.prompt, call.completion);
        addUsage(metrics.llm, call.prompt, call.completion);
      }
    } else if (task.details) {
      const detail = task.details;
      addUsage(
        metrics.execution,
        detail.promptTokens,
        detail.completionTokens,
        detail.modelCalls,
      );
      for (const usage of detail.modelUsage ?? [detail]) {
        addUsage(
          metrics.llm,
          usage.promptTokens,
          usage.completionTokens,
          'calls' in usage ? usage.calls : usage.modelCalls,
        );
      }
    }
  }
  const started = tasks.filter((task) => task.started_at !== null);
  // 开始和结束均用服务端时间；多组串行、并行及清理不能用子组耗时最大值替代。
  if (
    started.length &&
    started.every(
      (task) => task.finished_at !== null || task.state === 'RUNNING',
    )
  ) {
    const start = Math.min(
      ...started.map((task) => task.started_at!.getTime()),
    );
    const end = Math.max(
      ...started.map((task) => (task.finished_at ?? at).getTime()),
    );
    metrics.executionElapsedMs = Math.max(0, end - start);
  }
  metrics.totalTokens = metrics.execution.totalTokens;
  return metrics;
}
