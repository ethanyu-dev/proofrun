import {
  accessClientIp,
  normalizeIp,
  type ClientIpPolicy,
} from './client-ip.js';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AccessLogPage, AccessRecord } from '@proofrun/contracts';
import type { Database } from '../../db.js';
import { ApiError } from '../../domain.js';

/** 保留最近三十天，查询立即隐藏过期行，后台按批次回收磁盘记录。 */
const RETENTION_DAYS = 30;
const CLEANUP_INTERVAL_MS = 60_000;
const CLEANUP_BATCH = 10_000;
/** 每页限制为五十条，游标使用 PostgreSQL 有符号 bigint 的十进制范围。 */
const PAGE_SIZE = 50;
const MAX_CURSOR = 9_223_372_036_854_775_807n;
/** 只有此入口代表控制台手动连接或自动恢复的凭据验证。 */
export const CONSOLE_LOGIN_ROUTE = '/v1/admin/console-login';

/** 访问日志独立于业务事务；记录失败会告警，不改变已经完成的业务响应。 */
export class AccessLogs {
  /** 关闭数据库前等待所有已发起的记录，避免退出丢失尾部访问。 */
  private readonly pending = new Set<Promise<void>>();
  /** 清理不重入，关闭时等待当前批次结束。 */
  private cleaning: Promise<void> | undefined;
  /** 定时器只负责触发清理，不阻止进程退出。 */
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    /** 复用控制面连接池，不另建数据库或凭据体系。 */
    private readonly db: Database,
    /** 日志输出与请求生命周期均由同一个 Fastify 实例提供。 */
    private readonly app: FastifyInstance,
    /** 部署显式声明可信入口，不能由请求头切换解析模式。 */
    private readonly policy: ClientIpPolicy = {},
  ) {
    app.addHook('onResponse', (request, reply) => this.record(request, reply));
    app.addHook('onReady', async () => {
      await this.cleanup();
      this.timer = setInterval(() => void this.cleanup(), CLEANUP_INTERVAL_MS);
      this.timer.unref();
    });
  }

  /** 响应完成后才记录最终状态，覆盖鉴权失败、校验错误和未知路由。 */
  private async record(request: FastifyRequest, reply: FastifyReply) {
    const route = request.routeOptions.url ?? '(未匹配路由)';
    const duration = Math.max(0, reply.elapsedTime);
    const write = this.db
      .query(
        `INSERT INTO pr_access_logs(at,ip,kind,method,route,status_code,duration_ms)
         VALUES($1,$2::inet,$3,$4,$5,$6,$7)`,
        [
          new Date(Date.now() - duration),
          accessClientIp(request, this.policy),
          route === CONSOLE_LOGIN_ROUTE && request.method === 'POST'
            ? 'console_login'
            : 'http',
          request.method,
          route,
          reply.statusCode,
          duration,
        ],
      )
      .then(() => {})
      .catch((error: unknown) => {
        this.app.log.error({ err: error }, '访问记录写入失败');
      });
    this.pending.add(write);
    try {
      await write;
    } finally {
      this.pending.delete(write);
    }
  }

  /** 所有筛选先校验再参数化；不允许用任意 SQL、网段或无限页大小查询。 */
  async list(query: Record<string, unknown>): Promise<AccessLogPage> {
    const { kind, ip, before } = query;
    if (
      Object.keys(query).some(
        (key) => !['kind', 'ip', 'before'].includes(key),
      ) ||
      (kind !== undefined && kind !== 'console_login' && kind !== 'http') ||
      (ip !== undefined && (typeof ip !== 'string' || !normalizeIp(ip))) ||
      (before !== undefined &&
        (typeof before !== 'string' ||
          !/^[1-9][0-9]{0,18}$/.test(before) ||
          BigInt(before) > MAX_CURSOR))
    )
      throw new ApiError(
        400,
        'INVALID_ACCESS_FILTER',
        '访问筛选需要有效的类型、IP 或分页游标',
      );
    // 读取前等待此前已完成响应的写入，当前列表请求尚未进入 onResponse。
    await Promise.all(this.pending);
    const result = await this.db.query<AccessRecord>(
      `SELECT id::text, at, host(ip) AS ip, kind, method, route,
              status_code AS "statusCode", duration_ms AS "durationMs"
       FROM pr_access_logs
       WHERE at >= clock_timestamp() - $1 * interval '1 day'
         AND ($2::text IS NULL OR kind=$2)
         AND ($3::inet IS NULL OR ip=$3)
         AND ($4::bigint IS NULL OR id<$4)
       ORDER BY id DESC LIMIT $5`,
      [
        RETENTION_DAYS,
        kind ?? null,
        typeof ip === 'string' ? normalizeIp(ip) : null,
        before ?? null,
        PAGE_SIZE + 1,
      ],
    );
    const records = result.rows.slice(0, PAGE_SIZE);
    return {
      records,
      nextCursor: result.rows.length > PAGE_SIZE ? records.at(-1)!.id : null,
      retentionDays: RETENTION_DAYS,
    };
  }

  /** 单批回收过期行；失败只告警，下个周期继续，不阻断控制面启动。 */
  private cleanup(): Promise<void> {
    if (this.cleaning) return this.cleaning;
    this.cleaning = this.db
      .query(
        `DELETE FROM pr_access_logs WHERE id IN (
          SELECT id FROM pr_access_logs
          WHERE at < clock_timestamp() - $1 * interval '1 day'
          ORDER BY at LIMIT $2
        )`,
        [RETENTION_DAYS, CLEANUP_BATCH],
      )
      .then(() => {})
      .catch((error: unknown) =>
        this.app.log.error({ err: error }, '访问记录清理失败'),
      )
      .finally(() => {
        this.cleaning = undefined;
      });
    return this.cleaning;
  }

  /** 停止后台清理并排空记录，必须在数据库关闭前调用。 */
  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.cleaning;
    await Promise.all(this.pending);
  }
}
