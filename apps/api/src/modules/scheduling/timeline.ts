import type { ExecutionTimeline } from '@proofrun/contracts';
import type { Database } from '../../db.js';
import { ApiError, ID_PATTERN } from '../../domain.js';

/** 固定页长限制单次响应；使用命令身份游标，不截断完整历史。 */
const PAGE_SIZE = 200;

/** 只投影浏览器操作和截图元数据；输入值、Cookie、命令信封均不得返回。 */
export async function executionTimeline(
  db: Database,
  executionId: string,
  after?: string,
): Promise<ExecutionTimeline> {
  const execution = await db.query('SELECT id FROM pr_executions WHERE id=$1', [
    executionId,
  ]);
  if (!execution.rowCount)
    throw new ApiError(404, 'EXECUTION_MISSING', 'Execution not found');
  if (after) {
    if (!ID_PATTERN.test(after))
      throw new ApiError(400, 'INVALID_CURSOR', '无效的操作游标');
    const cursor = await db.query(
      'SELECT id FROM pr_commands WHERE execution_id=$1 AND id=$2 UNION ALL SELECT id FROM pr_human_commands WHERE execution_id=$1 AND id=$2',
      [executionId, after],
    );
    if (!cursor.rowCount)
      throw new ApiError(400, 'INVALID_CURSOR', '操作游标不属于当前执行');
  }
  const result = await db.query<ExecutionTimeline['commands'][number]>(
    `WITH command_rows AS (
      SELECT id,execution_id,kind,actor,envelope,result,created_at FROM pr_commands WHERE execution_id=$1 AND kind LIKE 'browser.%'
      UNION ALL
      SELECT id,execution_id,result#>>'{operation,type}' AS kind,'HUMAN' AS actor,jsonb_build_object('command',result->'operation') AS envelope,result,created_at FROM pr_human_commands WHERE execution_id=$1
    ) SELECT c.id,c.kind,c.actor,c.envelope#>>'{command,action}' AS action,c.envelope#>>'{command,tabScope}' AS "tabScope",
      c.result->>'operationStatus' AS status,c.result->>'effect' AS effect,
      c.result#>>'{error,code}' AS error,c.created_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'sha256',a.hash,'state',a.state) ORDER BY a.created_at,a.id)
        FROM pr_artifacts a WHERE a.command_id=c.id AND a.execution_id=c.execution_id AND a.kind='SCREENSHOT'), '[]'::jsonb) AS screenshots
    FROM command_rows c WHERE c.execution_id=$1
      AND ($2::text IS NULL OR (c.created_at,c.id) >
        (SELECT created_at,id FROM command_rows WHERE execution_id=$1 AND id=$2))
    ORDER BY c.created_at,c.id LIMIT $3`,
    [executionId, after ?? null, PAGE_SIZE + 1],
  );
  const commands = result.rows.slice(0, PAGE_SIZE);
  return {
    commands,
    nextCursor: result.rows.length > PAGE_SIZE ? commands.at(-1)!.id : null,
  };
}
