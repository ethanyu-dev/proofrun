import type { TaskList, TaskSummary } from '@proofrun/contracts';
import { Database } from '../../db.js';
import { ApiError, ID_PATTERN } from '../../domain.js';

/** 查询窗口受限，列表不读取完整任务和报告。 */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const STATES = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'CANCELLED',
  'TIMED_OUT',
  'ERROR',
];
/** 游标保留 PostgreSQL 的微秒精度，防止同毫秒记录跨页丢失。 */
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** 搜索按字面值匹配，输入中的百分号、下划线和反斜线不作为 SQL 通配符。 */
const LIKE_ESCAPE = /[\\%_]/g;

/** 游标绑定筛选条件；客户端更换筛选后需要从第一页开始。 */
interface Cursor {
  /** 保留微秒的数据库创建时间。 */
  at: string;
  /** 相同创建时间下的稳定排序键。 */
  id: string;
  /** 绑定搜索与状态筛选，防止跨条件复用游标。 */
  filter: string;
}

/** 查询对象不是协议写入，不参与任务调度或修改任务定义。 */
export class TaskReader {
  constructor(private readonly db: Database) {}

  async list(query: Record<string, unknown>): Promise<TaskList> {
    const invalid = () =>
      new ApiError(400, 'INVALID_QUERY', 'Invalid task list query or cursor');
    if (
      Object.keys(query).some(
        (key) => !['limit', 'cursor', 'state', 'q', 'reportOnly'].includes(key),
      )
    )
      throw invalid();
    if (Object.values(query).some((value) => typeof value !== 'string'))
      throw invalid();
    const limit =
      query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
    const state = query.state as string | undefined;
    const q = ((query.q as string | undefined) ?? '').trim();
    const reportOnly = query.reportOnly === 'true';
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_LIMIT ||
      (state && !STATES.includes(state)) ||
      q.length > 160 ||
      (query.reportOnly !== undefined &&
        !['true', 'false'].includes(query.reportOnly as string))
    )
      throw invalid();
    const filter = JSON.stringify([state ?? '', q, reportOnly]);
    let cursor: Cursor | null = null;
    if (query.cursor !== undefined) {
      try {
        const encoded = query.cursor as string;
        if (encoded.length > 2048) throw invalid();
        const parsed: unknown = JSON.parse(
          Buffer.from(encoded, 'base64url').toString('utf8'),
        );
        if (!parsed || typeof parsed !== 'object') throw invalid();
        const value = parsed as Cursor;
        if (
          typeof value.at !== 'string' ||
          !CURSOR_TIME.test(value.at) ||
          !Number.isFinite(Date.parse(value.at)) ||
          new Date(value.at).toISOString().slice(0, 19) !==
            value.at.slice(0, 19) ||
          typeof value.id !== 'string' ||
          !ID_PATTERN.test(value.id) ||
          value.filter !== filter
        )
          throw invalid();
        cursor = value;
      } catch {
        throw invalid();
      }
    }
    const rows = (
      await this.db.query<
        Omit<TaskSummary, 'created_at' | 'finished_at'> & {
          created_at: Date;
          finished_at: Date | null;
          cursor_at: string;
        }
      >(
        `SELECT id,left(definition->>'objective',240) AS objective,definition#>>'{environment,nodePool}' AS node_pool,
        definition#>>'{target,url}' AS target_url,state,created_at,finished_at,
        report->>'executionDisposition' AS execution_disposition,report->>'verdict' AS verdict,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
       FROM pr_tasks WHERE ($1::text IS NULL OR state=$1)
        AND ($2::text IS NULL OR id ILIKE $2 OR definition->>'objective' ILIKE $2)
        AND (NOT $3::boolean OR report IS NOT NULL)
        AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::text))
       ORDER BY created_at DESC,id DESC LIMIT $6`,
        [
          state || null,
          q ? `%${q.replace(LIKE_ESCAPE, '\\$&')}%` : null,
          reportOnly,
          cursor?.at ?? null,
          cursor?.id ?? null,
          limit + 1,
        ],
      )
    ).rows;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      tasks: page.map(({ cursor_at: _, ...task }) => ({
        ...task,
        created_at: task.created_at.toISOString(),
        finished_at: task.finished_at?.toISOString() ?? null,
      })),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ at: last.cursor_at, id: last.id, filter }),
            ).toString('base64url')
          : null,
    };
  }
}
