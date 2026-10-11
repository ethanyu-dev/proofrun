import type { PoolClient } from 'pg';
import type { VerificationTask, SessionPlan } from '@proofrun/contracts';

/** 在领取事务内分配账号；同一物理账号的别名和对照组共用容量。 */
export async function allocateIdentity(
  client: PoolClient,
  task: VerificationTask,
  routedNode?: string,
): Promise<VerificationTask | null> {
  const plan = task.sessionPlan;
  if (!plan?.candidates.length) return task;
  const existing = (
    await client.query<{ identity: SessionPlan['candidates'][number] }>(
      'SELECT identity FROM pr_identity_assignments WHERE task_id=$1',
      [task.taskId],
    )
  ).rows[0]?.identity;
  const candidates = existing ? [existing] : plan.candidates;
  for (const identity of candidates) {
    if (routedNode && identity.nodeId && identity.nodeId !== routedNode)
      continue;
    const key = identity.accountKey;
    const locked = (
      await client.query(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1,4)) AS locked',
        [key],
      )
    ).rows[0]?.locked;
    if (!locked) continue;
    const busy = (
      await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pr_identity_assignments a JOIN pr_tasks t ON t.id=a.task_id
      WHERE a.account_key=$1 AND a.task_id<>$2 AND (t.state='RUNNING' OR EXISTS(SELECT 1 FROM pr_executions e JOIN pr_sessions s ON s.execution_id=e.id WHERE e.task_id=t.id AND NOT s.closure_verified))`,
        [key, task.taskId],
      )
    ).rows[0];
    if (Number(busy?.count ?? 0) >= identity.maxConcurrent) continue;
    await client.query(
      'INSERT INTO pr_identity_assignments(task_id,account_key,identity) VALUES($1,$2,$3) ON CONFLICT(task_id) DO NOTHING',
      [task.taskId, key, JSON.stringify(identity)],
    );
    return { ...task, sessionPlan: { ...plan, candidates: [identity] } };
  }
  return null;
}
