import type { PoolClient } from 'pg';
import { Database } from '../../db.js';
import { ApiError } from '../../domain.js';

/** 批量删除有界；执行身份兼容历史双跑与清理前缀。 */
const MAX_DELETE = 100;
const TASK_ID = /^[A-Za-z0-9_-]{1,160}$/;

/** 删除只改变可见性，保留执行、会话和证据之间的不可变关联。 */
export class TaskLifecycle {
  constructor(
    /** 删除标记、摘要失效和分析撤权在同一事务提交。 */
    private readonly db: Database,
  ) {}

  /** 公共详情隐藏已删除任务，内部调度仍可读取历史事实。 */
  async visible(id: string) {
    const row = (
      await this.db.query(
        'SELECT 1 FROM pr_tasks WHERE id=$1 AND deleted_at IS NULL',
        [id],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, 'TASK_MISSING', '任务不存在或已删除');
  }

  /** 同一次请求原子删除，任一成员仍在运行或会话未关闭时整批拒绝。 */
  async remove(input: unknown, requests = false) {
    if (
      !Array.isArray(input) ||
      !input.length ||
      input.length > MAX_DELETE ||
      !input.every((id) => typeof id === 'string' && TASK_ID.test(id))
    )
      throw new ApiError(400, 'INVALID_DELETE', '需要 1–100 个有效身份');
    const ids = [...new Set(input as string[])].sort();
    return this.db.transaction(async (client) => {
      let taskIds = ids;
      if (requests) {
        const rows = await client.query(
          'SELECT request_id FROM pr_verification_requests WHERE request_id=ANY($1::text[]) ORDER BY request_id FOR UPDATE',
          [ids],
        );
        if (rows.rowCount !== ids.length)
          throw new ApiError(404, 'REQUEST_MISSING', '请求不存在');
        await client.query(
          'UPDATE pr_verification_requests SET deleted_at=coalesce(deleted_at,clock_timestamp()) WHERE request_id=ANY($1::text[])',
          [ids],
        );
        // 与共享提交和其他删除串行化，拿到执行锁后重新计算剩余引用。
        await client.query(
          `SELECT t.id FROM pr_tasks t WHERE t.id IN (SELECT task_id FROM pr_request_runs WHERE request_id=ANY($1::text[])) ORDER BY t.id FOR UPDATE`,
          [ids],
        );
        // 共享执行只在所有关联请求都被删除后排除，不能误伤仍可见的请求。
        taskIds = (
          await client.query<{ task_id: string }>(
            `SELECT DISTINCT a.task_id FROM pr_request_runs a WHERE a.request_id=ANY($1::text[])
          AND NOT EXISTS(SELECT 1 FROM pr_request_runs other JOIN pr_verification_requests r USING(request_id)
            WHERE other.task_id=a.task_id AND r.deleted_at IS NULL AND NOT r.request_id=ANY($1::text[]))`,
            [ids],
          )
        ).rows.map((r) => r.task_id);
        // 即使执行共享，正在运行的请求也不能被隐藏。
        const active = await client.query(
          `SELECT 1 FROM pr_request_runs a JOIN pr_tasks t ON t.id=a.task_id
          WHERE a.request_id=ANY($1::text[]) AND t.state IN ('QUEUED','RUNNING') LIMIT 1`,
          [ids],
        );
        if (active.rowCount)
          throw new ApiError(409, 'TASK_ACTIVE', '请等待任务结束后删除');
      }
      // comparison.id 表示本轮双跑；sourceTaskId 可能指向更早的普通任务，不能用于级联删除。
      const selected = await client.query(
        `SELECT t.id,coalesce('comparison:' || (p.definition#>>'{comparison,id}'),'task:' || p.id,'comparison:' || (t.definition#>>'{comparison,id}'),'task:' || t.id) AS root FROM pr_tasks t LEFT JOIN pr_tasks p ON p.id=coalesce(t.definition->>'parentTaskId',(SELECT parent_task_id FROM pr_case_cleanups WHERE task_id=t.id)) WHERE t.id=ANY($1::text[])`,
        [taskIds],
      );
      if (selected.rowCount !== taskIds.length)
        throw new ApiError(404, 'TASK_MISSING', '任务不存在');
      const roots = [...new Set<string>(selected.rows.map((r) => r.root))];
      const related = await client.query<{
        id: string;
        state: string;
        deleted_at: Date | null;
      }>(
        `WITH parents AS (
        SELECT id FROM pr_tasks WHERE coalesce('comparison:' || (definition#>>'{comparison,id}'),'task:' || id)=ANY($1::text[])
      ) SELECT id,state,deleted_at FROM pr_tasks WHERE id IN (SELECT id FROM parents)
        OR definition->>'parentTaskId' IN (SELECT id FROM parents)
        OR id IN (SELECT task_id FROM pr_case_cleanups WHERE parent_task_id IN (SELECT id FROM parents))
        ORDER BY id FOR UPDATE`,
        [roots],
      );
      const affected = related.rows.map((r) => r.id);
      if (related.rows.some((r) => ['QUEUED', 'RUNNING'].includes(r.state)))
        throw new ApiError(409, 'TASK_ACTIVE', '请等待任务及清理结束后删除');
      const resources = await client.query(
        `SELECT 1 FROM pr_executions e JOIN pr_sessions s ON s.execution_id=e.id WHERE e.task_id=ANY($1::text[]) AND NOT s.closure_verified
        UNION ALL SELECT 1 FROM pr_case_cleanups WHERE parent_task_id=ANY($1::text[]) AND state='PENDING' LIMIT 1`,
        [affected],
      );
      if (resources.rowCount)
        throw new ApiError(
          409,
          'TASK_RESOURCES_OPEN',
          '任务会话或清理尚未结束，请稍后删除',
        );
      const changed = related.rows
        .filter((r) => !r.deleted_at)
        .map((r) => r.id);
      await client.query(
        'UPDATE pr_tasks SET deleted_at=clock_timestamp() WHERE id=ANY($1::text[]) AND deleted_at IS NULL',
        [affected],
      );
      const requestIds = (
        await client.query<{ request_id: string }>(
          'SELECT DISTINCT request_id FROM pr_request_runs WHERE task_id=ANY($1::text[])',
          [changed],
        )
      ).rows.map((r) => r.request_id);
      if (requests) requestIds.push(...ids);
      await this.invalidateAnalyses(client, [...new Set(requestIds)]);
      return {
        deletedTaskIds: affected,
        deletedRequestIds: requests ? ids : [],
      };
    });
  }

  /** 成员变化后旧分析整体失效；无法可靠拆分的多 case 分析用量整轮排除。 */
  private async invalidateAnalyses(client: PoolClient, ids: string[]) {
    for (const id of [...ids].sort())
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`analysis:${id}`],
      );
    await client.query(
      `UPDATE pr_request_analyses SET excluded_at=clock_timestamp(),status='FAILED',token_hash=NULL,lease_until=NULL
      WHERE request_id=ANY($1::text[]) AND excluded_at IS NULL`,
      [ids],
    );
    await client.query(
      'UPDATE pr_analysis_calls SET excluded_at=clock_timestamp() WHERE request_id=ANY($1::text[]) AND excluded_at IS NULL',
      [ids],
    );
  }
}
