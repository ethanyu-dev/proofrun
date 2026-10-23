import type { PoolClient } from 'pg';
import type { Database } from '../../db.js';
import { RequestProjector, type RequestRow } from './projector.js';

/** 一次只装载有限请求的成员，历史回填可在批次之间提交并恢复。 */
export const REQUEST_SUMMARY_BATCH = 100;

/** 启动和维护共用可恢复回填，每批事务提交后才推进；失败保留未处理标记。 */
export async function drainRequestSummaries(db: Database): Promise<number> {
  let total = 0;
  for (;;) {
    const count = await db.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return refreshRequestSummaries(client, 1);
    });
    total += count;
    if (!count) return total;
  }
}

/** 显式重建不删除原摘要，读方仍按失效标记核对；中断后启动会继续剩余批次。 */
export async function rebuildRequestSummaries(db: Database): Promise<number> {
  await db.query(`INSERT INTO pr_request_summary_dirty(request_id)
    SELECT request_id FROM pr_verification_requests ORDER BY request_id
    ON CONFLICT(request_id) DO UPDATE SET revision=pr_request_summary_dirty.revision+1`);
  return drainRequestSummaries(db);
}

/** 调用方须开启可重复读事务；刷新与分页共享快照，不返回过时摘要。
 * 锁住失效标记直到提交；并发变更会等待或触发序列化重试，不能被清除标记吞掉。
 * 普通列表处理全部可见失效项；启动与维护传批次数，避免历史重建占用长事务。
 */
export async function refreshRequestSummaries(
  client: PoolClient,
  maxBatches = Number.POSITIVE_INFINITY,
): Promise<number> {
  const projector = new RequestProjector('');
  let refreshed = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const ids = (
      await client.query<{ request_id: string }>(
        'SELECT request_id FROM pr_request_summary_dirty ORDER BY request_id LIMIT $1 FOR UPDATE',
        [REQUEST_SUMMARY_BATCH],
      )
    ).rows.map((row) => row.request_id);
    if (!ids.length) break;
    const rows = (
      await client.query<RequestRow>(
        'SELECT * FROM pr_verification_requests WHERE request_id=ANY($1::text[])',
        [ids],
      )
    ).rows;
    const projected = await projector.project(client, rows, false);
    // 搜索口径保持原来的主任务目标；双跑另一组的定义不扩大搜索范围。
    const search = (
      await client.query<{ request_id: string; terms: string[] }>(
        `SELECT c.request_id,array_agg(c.case_id ORDER BY c.position) || array_agg(t.definition->>'objective' ORDER BY c.position) AS terms
       FROM pr_verification_request_cases c JOIN pr_tasks t ON t.id=c.task_id
       WHERE c.request_id=ANY($1::text[]) AND t.deleted_at IS NULL GROUP BY c.request_id`,
        [ids],
      )
    ).rows;
    const terms = new Map(search.map((row) => [row.request_id, row.terms]));
    const summaries = projected.map(
      ({
        requestId,
        createdAt,
        title: _title,
        sourceRequestId: _source,
        generatedAt: _at,
        cases: _cases,
        ...summary
      }) => ({
        request_id: requestId,
        summary,
        search_terms: [requestId, _title, ...(terms.get(requestId) ?? [])],
        search_text: [requestId, _title, ...(terms.get(requestId) ?? [])].join(
          '\n',
        ),
      }),
    );
    // 使用原表的微秒时间，不能将 JavaScript 的毫秒精度写回分页排序键。
    await client.query(
      `INSERT INTO pr_request_summaries(request_id,created_at,summary,search_terms,search_text)
      SELECT r.request_id,r.created_at,s.summary,s.search_terms,s.search_text FROM jsonb_to_recordset($1::jsonb) AS s(request_id text,summary jsonb,search_terms text[],search_text text)
      JOIN pr_verification_requests r USING(request_id)
      ON CONFLICT(request_id) DO UPDATE SET created_at=excluded.created_at,summary=excluded.summary,search_terms=excluded.search_terms,search_text=excluded.search_text`,
      [JSON.stringify(summaries)],
    );
    await client.query(
      'DELETE FROM pr_request_summary_dirty WHERE request_id=ANY($1::text[])',
      [ids],
    );
    refreshed += ids.length;
  }
  return refreshed;
}
