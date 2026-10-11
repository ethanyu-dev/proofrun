import type { TaskDetail, SessionPlan } from '@proofrun/contracts';
import type { Database } from '../../db.js';

/** 统计窗口固定三十天，避免历史日志无界扫描；指标不包含凭据或人工自由文本。 */
const WINDOW_DAYS = 30;
type IdentitySummary = NonNullable<TaskDetail['identity']>;
/** 仅投影所选身份和服务端回执；候选账号不会被误当成本次实际使用账号。 */
export async function identitySummary(
  db: Database,
  taskId: string,
  plan: SessionPlan,
): Promise<IdentitySummary> {
  const [assigned, preparations, humans] = await Promise.all([
    db.query(
      `SELECT a.identity->>'id' AS id,a.identity->>'label' AS label,
      (t.state='RUNNING' OR EXISTS(SELECT 1 FROM pr_executions e JOIN pr_sessions s ON s.execution_id=e.id WHERE e.task_id=t.id AND NOT s.closure_verified)) AS occupied,t.state
      FROM pr_identity_assignments a JOIN pr_tasks t ON t.id=a.task_id WHERE t.id=$1`,
      [taskId],
    ),
    db.query(
      `SELECT c.result,c.created_at,c.completed_at FROM pr_commands c JOIN pr_executions e ON e.id=c.execution_id
      WHERE e.task_id=$1 AND c.kind='browser.identity.prepare' ORDER BY c.created_at DESC LIMIT 1`,
      [taskId],
    ),
    db.query(
      `SELECT i.reason_code,count(*)::integer AS count,count(i.completed_at)::integer AS completed FROM pr_interventions i JOIN pr_executions e ON e.id=i.execution_id WHERE e.task_id=$1 GROUP BY i.reason_code ORDER BY i.reason_code`,
      [taskId],
    ),
  ]);
  const identity = assigned.rows[0];
  const prep = preparations.rows[0];
  const data = prep?.result?.data;
  const source: IdentitySummary['preparation']['source'] = [
    'snapshot',
    'cookies',
    'password',
  ].includes(data?.source)
    ? data.source
    : 'none';
  const status: IdentitySummary['preparation']['status'] = !prep
    ? 'NOT_REQUESTED'
    : !prep.result
      ? 'PENDING'
      : prep.result.operationStatus !== 'SUCCEEDED'
        ? 'ERROR'
        : data?.status === 'READY'
          ? 'READY'
          : 'NEEDS_HUMAN';
  return {
    mode: plan.mode,
    identityRef: identity?.id ?? null,
    label: identity?.label ?? null,
    leaseState: identity
      ? identity.occupied
        ? 'OCCUPIED'
        : identity.state === 'QUEUED'
          ? 'WAITING'
          : 'RELEASED'
      : plan.candidates.length
        ? 'WAITING'
        : 'NOT_REQUIRED',
    preparation: {
      status,
      source,
      reasonCode:
        typeof data?.reasonCode === 'string'
          ? data.reasonCode
          : (prep?.result?.error?.code ?? null),
      durationMs: prep?.completed_at
        ? Math.max(0, prep.completed_at.getTime() - prep.created_at.getTime())
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

/** 自动准备成功与人工介入分开计数，READY 不是业务验收通过。 */
export async function identityMetrics(db: Database) {
  const [attempts, hitl, accounts, waiting] = await Promise.all([
    db.query(
      `SELECT coalesce(c.result#>>'{data,source}','none') AS source,
      CASE WHEN c.result IS NULL THEN 'PENDING' WHEN c.result->>'operationStatus'<>'SUCCEEDED' THEN 'ERROR' ELSE coalesce(c.result#>>'{data,status}','ERROR') END AS status,
      count(*)::integer AS count,round(avg(extract(epoch from (c.completed_at-c.created_at))*1000))::integer AS "averageMs"
      FROM pr_commands c WHERE c.kind='browser.identity.prepare' AND c.created_at>clock_timestamp()-$1*interval '1 day' GROUP BY 1,2 ORDER BY 1,2`,
      [WINDOW_DAYS],
    ),
    db.query(
      `SELECT i.reason_code AS reason,count(*)::integer AS count,count(i.completed_at)::integer AS completed FROM pr_interventions i JOIN pr_executions e ON e.id=i.execution_id WHERE e.created_at>clock_timestamp()-$1*interval '1 day' GROUP BY 1 ORDER BY 1`,
      [WINDOW_DAYS],
    ),
    db.query(`SELECT a.account_key AS "accountKey",count(*)::integer AS occupied,min((a.identity->>'maxConcurrent')::integer) AS capacity
      FROM pr_identity_assignments a JOIN pr_tasks t ON t.id=a.task_id WHERE t.state='RUNNING' OR EXISTS(SELECT 1 FROM pr_executions e JOIN pr_sessions s ON s.execution_id=e.id WHERE e.task_id=t.id AND NOT s.closure_verified) GROUP BY 1 ORDER BY 1`),
    db.query(
      "SELECT count(*)::integer AS count FROM pr_tasks WHERE state='QUEUED' AND queue_reason->>'code'='IDENTITY_BUSY'",
    ),
  ]);
  const completed = attempts.rows
    .filter((r) => r.status !== 'PENDING')
    .reduce((n, r) => n + r.count, 0);
  const ready = attempts.rows
    .filter((r) => r.status === 'READY')
    .reduce((n, r) => n + r.count, 0);
  return {
    windowDays: WINDOW_DAYS,
    completedPreparations: completed,
    automaticReady: ready,
    automaticReadyRate: completed ? ready / completed : null,
    attempts: attempts.rows,
    hitl: hitl.rows,
    accounts: accounts.rows,
    waitingForIdentity: waiting.rows[0]?.count ?? 0,
  };
}
