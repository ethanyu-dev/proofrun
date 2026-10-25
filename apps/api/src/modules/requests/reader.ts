import type { PoolClient } from 'pg';
import type {
  RequestResultV2,
  RequestList,
  RequestSummary,
} from '@proofrun/contracts';
import { Database } from '../../db.js';
import { ApiError } from '../../domain.js';
import { RequestProjector, type RequestRow } from './projector.js';
import { refreshRequestSummaries } from './summary.js';
/** 请求身份不接受路径、空白或超长输入。 */
const REQUEST_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** 游标保留数据库微秒，且必须绑定完整筛选条件。 */
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** 搜索内容按字面匹配，百分号和下划线不能扩大匹配范围。 */
const LIKE_ESCAPE = /[\\%_]/g;

/** 持久摘要只含业务计数；身份与快照时间由本次读取补齐。 */
type StoredSummary = Omit<
  RequestSummary,
  'requestId' | 'title' | 'createdAt' | 'sourceRequestId' | 'generatedAt'
>;
/** 列表不读取任务定义、报告正文或证据，仅返回同一快照下的元数据与摘要。 */
interface SummaryRow {
  /** 冻结请求身份。 */
  request_id: string;
  /** 原请求标题，保持与详情一致。 */
  title: string;
  /** 展示时间；分页使用另外保留微秒的 cursor_at。 */
  created_at: Date;
  /** 重跑来源，不改变旧请求的成员关系。 */
  source_request_id: string | null;
  /** 数据库原始微秒排序键。 */
  cursor_at: string;
  /** 与共享汇总函数输出相同的计数和状态。 */
  summary: StoredSummary;
  /** 本次事务快照时间，不复用摘要生成时间。 */
  generated_at: Date;
}

/** 请求读取统一使用可重复读，报告导出与页面不会混合不同事务的计数。 */
export class RequestReader {
  constructor(
    /** 提供同一连接上的一致性读取事务。 */
    private readonly db: Database,
    /** 构造已有公开证据入口，不透传内部资源路径。 */
    publicUrl: string,
  ) {
    this.projector = new RequestProjector(publicUrl);
  }

  /** 详情始终读取原始事实，亦用于核对摘要一致性。 */
  private readonly projector: RequestProjector;

  /** 元数据查询供幂等提前返回；最终冲突检查仍位于写入事务内。 */
  async identity(id: string): Promise<{ hash: string } | null> {
    const row = (
      await this.db.query(
        'SELECT definition_hash FROM pr_verification_requests WHERE request_id=$1',
        [id],
      )
    ).rows[0];
    return row ? { hash: row.definition_hash } : null;
  }

  /** 单请求包含全部冻结成员，终态缺报告也保留在结果中。 */
  async get(id: string): Promise<RequestResultV2> {
    if (!REQUEST_ID.test(id))
      throw new ApiError(404, 'REQUEST_MISSING', '请求不存在');
    return this.db.transaction(async (client) => {
      await client.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      return this.snapshot(client, id);
    });
  }

  /** 供已有事务冻结分析输入，避免持锁时再占用第二条连接。 */
  async snapshot(client: PoolClient, id: string): Promise<RequestResultV2> {
    const rows = (
      await client.query<RequestRow>(
        'SELECT * FROM pr_verification_requests WHERE request_id=$1 AND deleted_at IS NULL',
        [id],
      )
    ).rows;
    if (!rows.length) throw new ApiError(404, 'REQUEST_MISSING', '请求不存在');
    return (await this.projector.project(client, rows, true))[0]!;
  }

  /** 反向导航显示全部关联，不假定共享 case 只有一个来源请求。 */
  async memberships(taskId: string) {
    return (
      await this.db.query<{ requestId: string; title: string }>(
        `SELECT r.request_id AS "requestId",r.title FROM pr_verification_requests r JOIN pr_request_runs a USING(request_id) WHERE a.task_id=$1 AND r.deleted_at IS NULL ORDER BY r.created_at DESC,r.request_id DESC`,
        [taskId],
      )
    ).rows;
  }

  /** 筛选只选请求；搜索命中某个成员时，仍汇总完整成员。 */
  async list(query: Record<string, unknown>): Promise<RequestList> {
    const invalid = () =>
      new ApiError(400, 'INVALID_QUERY', '请求筛选或游标无效');
    if (
      Object.keys(query).some(
        (k) =>
          !['q', 'executionStatus', 'reportStatus', 'limit', 'cursor'].includes(
            k,
          ),
      ) ||
      Object.values(query).some((v) => typeof v !== 'string')
    )
      throw invalid();
    const q = ((query.q as string) ?? '').trim();
    const executionStatus = (query.executionStatus as string) ?? '';
    const reportStatus = (query.reportStatus as string) ?? '';
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (
      q.length > 160 ||
      !['', 'QUEUED', 'IN_PROGRESS', 'FINISHED'].includes(executionStatus) ||
      !['', 'PASSED', 'FAILED', 'INCONCLUSIVE'].includes(reportStatus) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw invalid();
    const filter = JSON.stringify([q, executionStatus, reportStatus]);
    let cursor: { at: string; id: string; filter: string } | null = null;
    if (query.cursor) {
      try {
        if ((query.cursor as string).length > 2048) throw invalid();
        cursor = JSON.parse(
          Buffer.from(query.cursor as string, 'base64url').toString('utf8'),
        );
        if (
          !cursor ||
          typeof cursor.at !== 'string' ||
          typeof cursor.id !== 'string' ||
          !CURSOR_TIME.test(cursor.at) ||
          !Number.isFinite(Date.parse(cursor.at)) ||
          new Date(cursor.at).toISOString().slice(0, 19) !==
            cursor.at.slice(0, 19) ||
          !REQUEST_ID.test(cursor.id) ||
          cursor.filter !== filter
        )
          throw invalid();
      } catch {
        throw invalid();
      }
    }
    return this.db.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      // 失效标记与原始事实在同一快照读取；并发刷新或写入冲突由 Database 重试整次读取。
      await refreshRequestSummaries(client);
      const filters: string[] = [
        'r.deleted_at IS NULL',
        'EXISTS(SELECT 1 FROM pr_request_runs a JOIN pr_tasks t ON t.id=a.task_id WHERE a.request_id=r.request_id AND t.deleted_at IS NULL)',
      ];
      const values: unknown[] = [];
      const parameter = (value: unknown) => {
        values.push(value);
        return `$${values.length}`;
      };
      if (q) {
        const pattern = parameter(`%${q.replace(LIKE_ESCAPE, '\\$&')}%`);
        filters.push(
          `s.search_text ILIKE ${pattern} AND EXISTS(SELECT 1 FROM unnest(s.search_terms) term WHERE term ILIKE ${pattern})`,
        );
      }
      if (executionStatus)
        filters.push(`s.execution_status=${parameter(executionStatus)}`);
      if (reportStatus)
        filters.push(`s.report_status=${parameter(reportStatus)}`);
      if (cursor)
        filters.push(
          `(s.created_at,s.request_id)<(${parameter(cursor.at)}::timestamptz,${parameter(cursor.id)}::text)`,
        );
      const selected = (
        await client.query<SummaryRow>(
          `SELECT s.request_id,r.title,s.created_at,r.source_request_id,s.summary,
          to_char(s.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
          transaction_timestamp() AS generated_at
        FROM pr_request_summaries s JOIN pr_verification_requests r USING(request_id)
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY s.created_at DESC,s.request_id DESC LIMIT ${parameter(limit + 1)}`,
          values,
        )
      ).rows;
      const page = selected.slice(0, limit);
      const last = page.at(-1);
      return {
        requests: page.map((p) => ({
          ...p.summary,
          requestId: p.request_id,
          title: p.title,
          createdAt: p.created_at.toISOString(),
          sourceRequestId: p.source_request_id,
          generatedAt: p.generated_at.toISOString(),
        })),
        nextCursor:
          selected.length > limit && last
            ? Buffer.from(
                JSON.stringify({
                  at: last.cursor_at,
                  id: last.request_id,
                  filter,
                }),
              ).toString('base64url')
            : null,
      };
    });
  }
}
