import { randomUUID } from 'node:crypto';
import { validateVerificationTask } from '@proofrun/contracts';
import {
  isReleaseIdentity,
  type ReleaseIdentity,
} from '@proofrun/contracts/release';
import {
  BENCHMARK_SCENARIOS,
  BENCHMARK_LIMITS,
  benchmarkTask,
  benchmarkPage,
} from '@proofrun/contracts/benchmark-scenarios';
import type { Database } from '../../db.js';
import type { ApiConfig } from '../../config.js';
import { ApiError, canonical, digest } from '../../domain.js';
import { benchmarkArchive } from './archive.js';

/** 队列和关闭有固定期限，不因 API 重启或无人领取无限等待。 */
const RUN_MS = 10 * 60_000;
const ID = /^[a-f0-9-]{36}$/;
/** 管理员创建固定套件；后台复用原任务调度器，数据库保存状态和完整归档。 */
export class Benchmarks {
  constructor(
    readonly db: Database,
    readonly config: ApiConfig,
    readonly release: ReleaseIdentity,
  ) {}
  status() {
    return {
      enabled: !!(
        this.config.benchmarkNodePool &&
        this.config.benchmarkEnvironment &&
        this.release.kind === 'release' &&
        this.release.commit &&
        this.release.sourceFingerprint
      ),
      release: this.release,
      environment: this.config.benchmarkEnvironment ?? 'unconfigured',
      nodePool: this.config.benchmarkNodePool ?? null,
    };
  }
  /** 创建身份由客户端预先生成以支持未知网络结果后的幂等核查；版本始终取服务端构建清单。 */
  async create(body: unknown) {
    const input = body as { id?: unknown } | null;
    if (
      !input ||
      Object.keys(input).join() !== 'id' ||
      typeof input.id !== 'string' ||
      !ID.test(input.id)
    )
      throw new ApiError(
        400,
        'INVALID_BENCHMARK',
        '需要独立运行 UUID，不接受指定部署版本或目标地址',
      );
    const id = input.id;
    if (!this.config.benchmarkNodePool || !this.config.benchmarkEnvironment)
      throw new ApiError(
        409,
        'BENCHMARK_DISABLED',
        '服务端尚未配置基准节点池及环境',
      );
    if (
      this.release.kind !== 'release' ||
      !this.release.sourceFingerprint ||
      !this.release.commit
    )
      throw new ApiError(
        409,
        'BUILD_IDENTITY_MISSING',
        '缺少可信构建版本清单，不能记录实际部署版本',
      );
    await this.db.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('benchmark-create',0))",
      );
      if (
        (
          await client.query('SELECT id FROM pr_benchmark_runs WHERE id=$1', [
            id,
          ])
        ).rowCount
      )
        return;
      if (
        (
          await client.query(
            "SELECT id FROM pr_benchmark_runs WHERE state IN ('QUEUED','RUNNING')",
          )
        ).rowCount
      )
        throw new ApiError(409, 'BENCHMARK_BUSY', '已有线上基准正在排队或执行');
      await client.query(
        "INSERT INTO pr_benchmark_runs(id,release,environment,deadline_at) VALUES($1,$2,$3,clock_timestamp()+$4*interval '1 millisecond')",
        [id, this.release, this.config.benchmarkEnvironment, RUN_MS],
      );
      for (const scenario of BENCHMARK_SCENARIOS) {
        const taskId = randomUUID();
        const task = benchmarkTask(
          taskId,
          scenario.id,
          `${this.config.publicUrl.replace(/\/$/, '')}/v1/benchmark-fixtures/${taskId}`,
          this.config.benchmarkNodePool!,
        );
        if (!validateVerificationTask(task))
          throw new Error('内置基准任务不符合协议');
        await client.query(
          "INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at,runtime_version) VALUES($1,$2,$3,'QUEUED',clock_timestamp()+$4*interval '1 millisecond',1)",
          [taskId, task, digest(canonical(task)), BENCHMARK_LIMITS.timeoutMs],
        );
        await client.query(
          'INSERT INTO pr_benchmark_cases(task_id,run_id,scenario) VALUES($1,$2,$3)',
          [taskId, id, scenario.id],
        );
      }
    });
    return { id };
  }
  /** 按版本分页读取轻量元数据，展开某次运行才读取完整上下文。 */
  async list(version?: string, after?: string) {
    if ((version && version.length > 128) || (after && !ID.test(after)))
      throw new ApiError(400, 'INVALID_QUERY', '版本或游标无效');
    const rows = (
      await this.db.query(
        `SELECT id,release,environment,state,created_at AS "createdAt",finished_at AS "finishedAt" FROM pr_benchmark_runs WHERE ($1::text IS NULL OR release->>'version'=$1) AND ($2::text IS NULL OR (created_at,id)<(SELECT created_at,id FROM pr_benchmark_runs WHERE id=$2)) ORDER BY created_at DESC,id DESC LIMIT 21`,
        [version ?? null, after ?? null],
      )
    ).rows;
    return {
      runs: rows.slice(0, 20),
      nextCursor: rows.length > 20 ? rows[19]!.id : null,
    };
  }
  async versions() {
    return {
      versions: (
        await this.db.query(
          `SELECT release->>'version' AS version,count(*)::int AS count,max(created_at) AS "latestAt" FROM pr_benchmark_runs GROUP BY release->>'version' ORDER BY max(created_at) DESC LIMIT 200`,
        )
      ).rows,
    };
  }
  async detail(id: string) {
    const row = (
      await this.db.query('SELECT * FROM pr_benchmark_runs WHERE id=$1', [id])
    ).rows[0];
    if (!row) throw new ApiError(404, 'BENCHMARK_MISSING', '基准运行不存在');
    return {
      state: row.state,
      run: row.archive ?? (await benchmarkArchive(this.db, row, false)),
    };
  }
  /** 每次扫描只结算已结束且已核实关闭的完整套件；重启后直接继续对账，不重放动作。 */
  async tick() {
    const active = (
      await this.db.query(
        "SELECT * FROM pr_benchmark_runs WHERE state IN ('QUEUED','RUNNING') ORDER BY created_at LIMIT 1",
      )
    ).rows[0];
    if (!active) return;
    const cases = (
      await this.db.query(
        `SELECT t.state,s.closure_verified FROM pr_benchmark_cases b JOIN pr_tasks t ON t.id=b.task_id LEFT JOIN pr_executions e ON e.task_id=t.id LEFT JOIN pr_sessions s ON s.execution_id=e.id WHERE b.run_id=$1`,
        [active.id],
      )
    ).rows;
    const expired = active.deadline_at.getTime() <= Date.now();
    const terminal =
      cases.length === BENCHMARK_SCENARIOS.length &&
      cases.every(
        (row) =>
          !['QUEUED', 'RUNNING'].includes(row.state) &&
          row.closure_verified !== false,
      );
    if (terminal || expired) {
      const run = await benchmarkArchive(this.db, active, true);
      const passed = run.cases.every((item) =>
        item.checks.every((check) => check.passed),
      );
      await this.db.query(
        'UPDATE pr_benchmark_runs SET state=$2,archive=$3,finished_at=clock_timestamp() WHERE id=$1 AND archive IS NULL',
        [active.id, passed ? 'COMPLETED' : 'FAILED', run],
      );
    } else if (cases.some((row) => row.state !== 'QUEUED'))
      await this.db.query(
        "UPDATE pr_benchmark_runs SET state='RUNNING' WHERE id=$1",
        [active.id],
      );
  }
  /** 只接受当前执行令牌；部署身份及模型选项写一次，重送必须完全相同。 */
  async agent(executionId: string, token: string, body: any) {
    if (
      !body ||
      !isReleaseIdentity(body.release) ||
      !body.model ||
      typeof body.model.name !== 'string' ||
      body.model.name.length > 160 ||
      Object.keys(body).sort().join() !== 'model,release'
    )
      throw new ApiError(400, 'INVALID_BUILD_IDENTITY', 'Agent 构建身份无效');
    const keys = [
      'name',
      'vision',
      'tokenParameter',
      'maxTokens',
      'thinking',
      'reasoningEffort',
      'endpointFingerprint',
      'modelMs',
    ];
    if (
      Object.keys(body.model).sort().join() !== keys.sort().join() ||
      typeof body.model.vision !== 'boolean' ||
      !['max_tokens', 'max_completion_tokens'].includes(
        body.model.tokenParameter,
      ) ||
      !Number.isInteger(body.model.maxTokens) ||
      body.model.maxTokens < 1 ||
      body.model.maxTokens > 65536 ||
      !['default', 'enabled', 'disabled'].includes(body.model.thinking) ||
      !['default', 'low', 'high', 'max'].includes(body.model.reasoningEffort) ||
      !/^[a-f0-9]{64}$/.test(body.model.endpointFingerprint) ||
      !Number.isInteger(body.model.modelMs) ||
      body.model.modelMs < 1 ||
      body.model.modelMs > 600000
    )
      throw new ApiError(400, 'INVALID_MODEL_CONFIG', '模型配置无效');
    await this.db.transaction(async (client) => {
      const row = (
        await client.query(
          `SELECT b.*,e.token_hash,e.lease_expires_at,e.state AS execution_state FROM pr_benchmark_cases b JOIN pr_executions e ON e.task_id=b.task_id WHERE e.id=$1 FOR UPDATE OF b`,
          [executionId],
        )
      ).rows[0];
      if (!row || row.token_hash !== digest(token))
        throw new ApiError(401, 'UNAUTHORIZED', '执行凭据无效');
      if (row.agent_release) {
        if (
          canonical(row.agent_release) !== canonical(body.release) ||
          canonical(row.model_config) !== canonical(body.model)
        )
          throw new ApiError(
            409,
            'BUILD_IDENTITY_CONFLICT',
            '实际执行身份已经冻结',
          );
        return;
      }
      if (
        !['STARTING', 'RUNNING'].includes(row.execution_state) ||
        row.lease_expires_at.getTime() <= Date.now()
      )
        throw new ApiError(409, 'EXECUTION_EXPIRED', '执行权限已过期');
      await client.query(
        'UPDATE pr_benchmark_cases SET agent_release=$2,model_config=$3 WHERE task_id=$1',
        [row.task_id, body.release, body.model],
      );
    });
    return { recorded: true };
  }
  /** 合成页面只有随机任务路径可访问，完成后关闭；独立账本如实保留重复写入。 */
  async fixture(id: string, body?: unknown) {
    return this.db.transaction(async (client) => {
      const row = (
        await client.query(
          `SELECT b.*,t.state,t.deadline_at FROM pr_benchmark_cases b JOIN pr_tasks t ON t.id=b.task_id WHERE b.task_id=$1 FOR UPDATE OF b`,
          [id],
        )
      ).rows[0];
      if (
        !row ||
        row.state !== 'RUNNING' ||
        row.deadline_at.getTime() <= Date.now()
      )
        throw new ApiError(
          404,
          'BENCHMARK_FIXTURE_CLOSED',
          '合成场景不存在或已结束',
        );
      if (body === undefined) {
        await client.query(
          'UPDATE pr_benchmark_cases SET visits=visits+1 WHERE task_id=$1',
          [id],
        );
        return benchmarkPage(row.scenario);
      }
      const value = body as any;
      if (
        !value ||
        Object.keys(value).sort().join() !== 'city,name' ||
        typeof value.name !== 'string' ||
        typeof value.city !== 'string' ||
        value.name.length > 128 ||
        value.city.length > 128 ||
        row.writes.length >= 20
      )
        throw new ApiError(
          400,
          'INVALID_BENCHMARK_DATA',
          '合成表单输入无效或提交次数超限',
        );
      await client.query(
        'UPDATE pr_benchmark_cases SET writes=writes || $2::jsonb WHERE task_id=$1',
        [id, JSON.stringify([value])],
      );
      return { ...value, count: row.writes.length + 1 };
    });
  }
}
