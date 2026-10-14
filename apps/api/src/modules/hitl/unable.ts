import type { PoolClient } from 'pg';
import type {
  StepResult,
  VerificationReport,
  VerificationTask,
} from '@proofrun/contracts';
import { executionContext, stopExecution } from '../scheduling/state.js';

/** 人工终止只补齐未执行部分，已经记录的验收结果和证据保持原样。 */
export async function recordHumanUnable(
  client: PoolClient,
  taskId: string,
  reason: string,
  publicUrl: string,
) {
  const row = (
    await client.query<{
      definition: VerificationTask;
      state: string;
      step_results: StepResult[] | null;
    }>(
      'SELECT definition,state,step_results FROM pr_tasks WHERE id=$1 FOR UPDATE',
      [taskId],
    )
  ).rows[0];
  if (!row || !['QUEUED', 'RUNNING'].includes(row.state)) return;
  const now = new Date().toISOString();
  const execution = (
    await client.query<{ id: string }>(
      'SELECT id FROM pr_executions WHERE task_id=$1',
      [taskId],
    )
  ).rows[0];
  const recorded = new Map(
    (row.step_results ?? []).map((step) => [step.stepId, step]),
  );
  const steps: StepResult[] = (row.definition.steps ?? []).map((step) => {
    const existing = recorded.get(step.stepId!);
    if (existing && !['PENDING', 'RUNNING'].includes(existing.status))
      return existing;
    return {
      ...(existing ?? {
        stepId: step.stepId!,
        criteria: [],
        evidenceRefs: [],
        startedAt: null,
      }),
      status: existing?.status === 'RUNNING' ? 'BLOCKED' : 'SKIPPED',
      summary: reason,
      reasonCode: 'HUMAN_UNEXECUTABLE',
      finishedAt: existing?.startedAt ? now : null,
    };
  });
  const criteria = row.definition.acceptanceCriteria.map(
    (criterion) =>
      steps
        .flatMap((step) => step.criteria)
        .find((item) => item.criterionId === criterion.id) ?? {
        criterionId: criterion.id,
        verdict: 'SKIPPED' as const,
        summary: reason,
        evidenceRefs: [],
      },
  );
  const artifacts = execution
    ? (
        await client.query<{
          id: string;
          kind: VerificationReport['artifacts'][number]['kind'];
          hash: string;
        }>(
          "SELECT id,kind,hash FROM pr_artifacts WHERE execution_id=$1 AND state='AVAILABLE'",
          [execution.id],
        )
      ).rows.map((item) => ({
        id: item.id,
        kind: item.kind,
        sha256: item.hash,
        uri: `${publicUrl}/v1/artifacts/${item.id}`,
      }))
    : [];
  const report: VerificationReport = {
    protocolVersion: '0.1',
    taskId,
    lifecycle: 'COMPLETED',
    executionDisposition: 'BLOCKED',
    verdict: null,
    summary: reason,
    criteria,
    artifacts,
    ...(steps.length
      ? { steps: steps as NonNullable<VerificationReport['steps']> }
      : {}),
    humanDecision: { outcome: 'UNEXECUTABLE', reason, decidedAt: now },
  };
  await client.query(
    'UPDATE pr_tasks SET report=$2,step_results=$3 WHERE id=$1',
    [taskId, report, steps.length ? JSON.stringify(steps) : null],
  );
  if (execution)
    await stopExecution(
      client,
      await executionContext(client, execution.id),
      'COMPLETED',
      'HUMAN_UNEXECUTABLE',
    );
  else
    await client.query(
      "UPDATE pr_tasks SET state='COMPLETED',finished_at=clock_timestamp() WHERE id=$1",
      [taskId],
    );
}
