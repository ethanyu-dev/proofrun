import type { TaskDetail, SessionPlan } from '@proofrun/contracts';
import type { Database } from '../../db.js';

type IdentitySummary = NonNullable<TaskDetail['identity']>;
/** 仅汇总 DevPass 租约与当前会话人工处理，不读取本地身份库。 */
export async function identitySummary(
  db: Database,
  taskId: string,
  plan: SessionPlan,
): Promise<IdentitySummary> {
  const humans = await db.query(
    `SELECT i.reason_code,count(*)::integer AS count,count(i.completed_at)::integer AS completed FROM pr_interventions i JOIN pr_executions e ON e.id=i.execution_id WHERE e.task_id=$1 GROUP BY i.reason_code ORDER BY i.reason_code`,
    [taskId],
  );
  const external =
    plan.external || plan.automatic?.fallbackReason
      ? (
          await db.query(
            'SELECT request_id,lease_id,account_id,material_version,expires_at,state,reason FROM pr_external_accounts WHERE task_id=$1',
            [taskId],
          )
        ).rows[0]
      : undefined;
  const externalOpen = plan.external
    ? (
        await db.query(
          "SELECT c.result,c.created_at,c.completed_at,t.error->>'code' AS task_error FROM pr_commands c JOIN pr_executions e ON e.id=c.execution_id JOIN pr_tasks t ON t.id=e.task_id WHERE e.task_id=$1 AND c.kind='session.open' ORDER BY c.created_at DESC LIMIT 1",
          [taskId],
        )
      ).rows[0]
    : undefined;
  return {
    ...(external
      ? {
          external: {
            requestId: external.request_id,
            leaseId: external.lease_id,
            accountId: external.account_id,
            materialVersion: external.material_version,
            expiresAt: external.expires_at?.toISOString() ?? null,
            state: external.state,
            reason: external.reason,
          },
        }
      : {}),
    mode: plan.mode,
    identityRef: external?.account_id ?? null,
    label: plan.external
      ? `DevPass · ${external?.account_id ?? '等待分配'}`
      : null,
    leaseState: plan.external
      ? !external || (external.state === 'REQUESTED' && !external.lease_id)
        ? 'WAITING'
        : external.state === 'RELEASED'
          ? 'RELEASED'
          : 'OCCUPIED'
      : 'NOT_REQUIRED',
    preparation: {
      status: plan.external
        ? externalOpen?.task_error === 'EXTERNAL_ACCOUNT_PROOF_MISMATCH'
          ? 'ERROR'
          : externalOpen?.result?.operationStatus === 'SUCCEEDED'
            ? 'LOADED'
            : externalOpen?.result
              ? 'ERROR'
              : external?.state === 'REVIEW'
                ? 'ERROR'
                : 'PENDING'
        : 'NOT_REQUESTED',
      source: plan.external ? 'cookies' : 'none',
      reasonCode: plan.external
        ? (external?.reason ?? externalOpen?.task_error ?? null)
        : (plan.automatic?.fallbackReason ?? null),
      durationMs: plan.external
        ? externalOpen?.completed_at
          ? Math.max(
              0,
              externalOpen.completed_at.getTime() -
                externalOpen.created_at.getTime(),
            )
          : null
        : null,
    },
    humanRequests: humans.rows.reduce((n, r) => n + r.count, 0),
    humanCompleted: humans.rows.reduce((n, r) => n + r.completed, 0),
    humanReasons: humans.rows.map((r) => ({
      reason: r.reason_code,
      count: r.count,
    })),
  };
}
