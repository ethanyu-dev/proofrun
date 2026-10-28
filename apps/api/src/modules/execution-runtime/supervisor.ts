import type { PoolClient } from 'pg';
import type { Database } from '../../db.js';
import { executionContext, stopExecution } from '../scheduling/state.js';

/** 终态只收敛已有命令事实；已入队但缺回执必须标为 UNKNOWN，不能声称没有发生效果。 */
export async function settleRuntimeOperations(
  client: PoolClient,
  executionId: string | null = null,
) {
  await client.query(
    `UPDATE pr_runtime_operations o SET state=CASE WHEN c.result IS NOT NULL THEN 'FINISHED' ELSE 'UNKNOWN' END,result=c.result FROM pr_commands c,pr_execution_runtimes r WHERE o.command_id=c.id AND o.execution_id=r.execution_id AND r.state<>'ACTIVE' AND o.state IN ('PENDING','DISPATCHED','UNKNOWN') AND ($1::text IS NULL OR o.execution_id=$1)`,
    [executionId],
  );
  await client.query(
    `UPDATE pr_runtime_operations o SET state='ABORTED' FROM pr_execution_runtimes r WHERE o.execution_id=r.execution_id AND r.state<>'ACTIVE' AND o.state IN ('PENDING','DISPATCHED') AND NOT EXISTS(SELECT 1 FROM pr_commands c WHERE c.id=o.command_id) AND ($1::text IS NULL OR o.execution_id=$1)`,
    [executionId],
  );
}

/** 无可恢复进程栈时只关闭原执行；不会把操作日志作为自动重放业务动作的授权。 */
export async function recoverLostRuntimes(db: Database) {
  const rows = (
    await db.query(
      `SELECT e.id FROM pr_executions e JOIN pr_tasks t ON t.id=e.task_id WHERE t.runtime_version=1 AND e.state IN ('STARTING','RUNNING')`,
    )
  ).rows;
  for (const row of rows)
    await db.transaction(async (client) => {
      const context = await executionContext(client, row.id);
      await stopExecution(client, context, 'ERROR', 'EXECUTION_RUNTIME_LOST');
    });
  await db.transaction(async (client) => {
    await client.query(
      "UPDATE pr_execution_runtimes SET state='LOST',error_code='EXECUTION_RUNTIME_LOST',updated_at=clock_timestamp() WHERE state='ACTIVE'",
    );
    await client.query(
      "UPDATE pr_runtime_decisions SET state='ABORTED' WHERE state='WAITING' AND execution_id IN (SELECT execution_id FROM pr_execution_runtimes WHERE state='LOST')",
    );
    await settleRuntimeOperations(client);
  });
}
