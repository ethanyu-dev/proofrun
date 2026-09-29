import { readFile } from 'node:fs/promises';
import pg, { type PoolClient, type QueryResultRow } from 'pg';

/** 固定应用级锁，确保主备副本中只有持锁实例运行网关和调度器。 */
const INSTANCE_LOCK = 'proofrun-control-plane-v1';
/** 仅重试数据库已回滚的并发冲突，不能在事务函数中发送浏览器命令。 */
const TRANSACTION_ATTEMPTS = 3;
/** 锁连接探测同时限制静默网络断连的检测时间；超时后只允许退出，不能续用旧所有权。 */
const OWNER_PROBE_MS = 1000;
const OWNER_TIMEOUT_MS = 2000;
/** 有序升级新项目的持久库；每个脚本与版本登记在同一事务中提交。 */
const MIGRATIONS = [
  '001-control-plane.sql',
  '002-task-browser.sql',
  '003-execution-control.sql',
  '004-hitl.sql',
  '005-trace.sql',
  '006-model-calls.sql',
  '007-node-routing.sql',
  '008-auth-snapshots.sql',
  '009-structured-cases.sql',
];

/** 所有业务事务使用同一连接；独占连接单独维护控制面实例锁。 */
export class Database {
  /** 业务查询连接池；预留一个连接用于实例锁。 */
  readonly pool: pg.Pool;
  /** 实例锁必须绑定未进入普通池复用的长期连接。 */
  private owner: PoolClient | undefined;
  /** 锁连接出错后停止准入，必须重启而不能猜测仍持有所有权。 */
  healthy = true;
  /** 探测绑定持锁连接，普通业务池可用不能证明实例仍持锁。 */
  private probeTimer: ReturnType<typeof setInterval> | undefined;
  private probing: Promise<void> | undefined;

  constructor(url: string) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 12,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: OWNER_PROBE_MS,
    });
    this.pool.on('error', () => {
      this.healthy = false;
    });
  }

  /** 占有实例锁后执行新库迁移；旧数据结构不做隐式兼容。 */
  async start(): Promise<void> {
    this.owner = await this.pool.connect();
    this.owner.on('error', () => {
      this.healthy = false;
    });
    const result = await this.owner.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',
      [INSTANCE_LOCK],
    );
    if (!result.rows[0].acquired) {
      this.owner.release();
      this.owner = undefined;
      throw new Error('Another ProofRun API owns this database');
    }
    this.probeTimer = setInterval(() => {
      if (!this.owner || this.probing || !this.healthy) return;
      const probe = { text: 'SELECT 1', query_timeout: OWNER_TIMEOUT_MS };
      this.probing = this.owner
        .query(probe)
        .then(() => {})
        .catch(() => {
          this.healthy = false;
        })
        .finally(() => {
          this.probing = undefined;
        });
    }, OWNER_PROBE_MS);
    this.probeTimer.unref();
    await this.transaction(async (client) => {
      await client.query(
        'CREATE TABLE IF NOT EXISTS pr_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())',
      );
      for (const [index, file] of MIGRATIONS.entries()) {
        const version = index + 1;
        const existing = await client.query(
          'SELECT version FROM pr_migrations WHERE version=$1',
          [version],
        );
        if (existing.rowCount) continue;
        await client.query(
          await readFile(
            new URL(`../migrations/${file}`, import.meta.url),
            'utf8',
          ),
        );
        await client.query('INSERT INTO pr_migrations(version) VALUES($1)', [
          version,
        ]);
      }
    });
  }

  /** 保持事务短小；传输和文件写入必须在事务之外完成。 */
  async transaction<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.healthy) throw new Error('Control-plane database ownership lost');
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const value = await body(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        const code = (error as { code?: string }).code;
        if (
          attempt + 1 >= TRANSACTION_ATTEMPTS ||
          !['40001', '40P01'].includes(code ?? '')
        )
          throw error;
      } finally {
        client.release();
      }
    }
  }

  /** 简单查询不借用实例锁连接。 */
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ) {
    return this.pool.query<T>(sql, values);
  }

  /** 关闭后释放实例锁，允许下一次启动接管持久状态。 */
  async close(): Promise<void> {
    clearInterval(this.probeTimer);
    await this.probing;
    if (this.owner) {
      // 销毁持锁连接即释放 session lock，也避免断网时等待解锁查询。
      this.owner.release(true);
      this.owner = undefined;
    }
    await this.pool.end();
  }
}
