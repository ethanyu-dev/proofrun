import { randomUUID } from 'node:crypto';
import { benchmarkRuntimeLimits } from '@proofrun/contracts/benchmark-scenarios';
import type { ExecutionGrant, RuntimeRequest } from '@proofrun/contracts';
import { execute } from '@proofrun/execution-driver/execution/runner';
import { ExecutionFault } from '@proofrun/execution-core/faults';
import type {
  DecisionInput,
  DecisionOutput,
} from '@proofrun/execution-core/model';
import type {
  RuntimeConfig,
  RuntimeView,
  RuntimeDecisionFrame,
} from '@proofrun/execution-core/runtime';
import type { PoolClient } from 'pg';
import type { Database } from '../../db.js';
import { ApiError, canonical, digest } from '../../domain.js';
import {
  executionContext,
  stopExecution,
  type ExecutionContext,
} from '../scheduling/state.js';
import { executionDeadline } from '../scheduling/execution-time.js';
import { RuntimeDriver } from './driver.js';
import { recoverLostRuntimes, settleRuntimeOperations } from './supervisor.js';

/** 决定等待只持有进程回调，身份、版本、输入与结果必须先持久化。 */
interface PendingDecision {
  /** 当前帧的宿主回调，不能作为跨进程恢复状态。 */
  input: DecisionInput;
  /** 决定事务提交后才交还原驱动。 */
  resolve: (value: DecisionOutput) => void;
  /** 撤权或审计失败使原驱动停止使用该帧。 */
  reject: (reason: unknown) => void;
  /** 同进程并发重送共用一次审计提交。 */
  trace?: Promise<
    Awaited<ReturnType<NonNullable<DecisionInput['traceRequest']>>>
  >;
  /** 用量归属实际审计请求中的模型，适配器选择可以不同于运行默认配置。 */
  traceModel?: string;
  /** 回复与用量只应用一次，失败也复用原失败结果。 */
  finish?: Promise<void>;
}
/** 进程栈不会被错误地当作跨重启可恢复状态；失去它必须结束执行。 */
interface ActiveRuntime {
  /** 关闭宿主时撤销驱动及决定等待。 */
  stop: AbortController;
  /** 数据库释放前等待收尾。 */
  running: Promise<void>;
}
/** 服务拥有状态、驱动和决定版本；worker 只持有模型适配器及实际续租责任。 */
export class ExecutionRuntime {
  private readonly active = new Map<string, ActiveRuntime>();
  private readonly pending = new Map<string, PendingDecision>();
  private closing = false;
  constructor(
    private readonly db: Database,
    private readonly driver: RuntimeDriver,
    private readonly publicUrl: string,
  ) {}

  /** 在接受新请求和启动调度定时器前关闭上个 API 进程遗留的版本 1 执行。 */
  recover() {
    return recoverLostRuntimes(this.db);
  }

  /** 每次请求都核对执行身份；活跃校验与加锁可独立选择。 */
  private async authorized(
    client: PoolClient,
    id: string,
    token: string,
    active = false,
    lock = active,
  ): Promise<ExecutionContext> {
    const context = await executionContext(client, id, { lock });
    if (digest(token) !== context.token_hash)
      throw new ApiError(401, 'UNAUTHORIZED', '执行凭据无效');
    if (context.runtime_version !== 1)
      throw new ApiError(
        409,
        'RUNTIME_VERSION_CONFLICT',
        '该运行属于旧执行路径',
      );
    if (
      active &&
      (context.task_state !== 'RUNNING' ||
        !['STARTING', 'RUNNING'].includes(context.execution_state) ||
        context.lease_expires_at.getTime() <= Date.now() ||
        executionDeadline(context) <= Date.now())
    )
      throw new ApiError(409, 'EXECUTION_EXPIRED', '执行权限已失效');
    return context;
  }

  /** 路由旁路围栏不影响旧运行，也不阻止人工管理员的原控制路径。 */
  async requireLegacy(id: string, token: string) {
    const row = (
      await this.db.query(
        'SELECT e.token_hash,t.runtime_version FROM pr_executions e JOIN pr_tasks t ON t.id=e.task_id WHERE e.id=$1',
        [id],
      )
    ).rows[0];
    if (row?.runtime_version === 1) {
      if (digest(token) !== row.token_hash)
        throw new ApiError(401, 'UNAUTHORIZED', '执行凭据无效');
      throw new ApiError(
        409,
        'EXECUTION_RUNTIME_REQUIRED',
        '版本 1 的自动写入必须经过运行时决定接口',
      );
    }
  }

  /** 配置只包含非秘密的执行策略并在首次启动冻结；相同请求可安全重送。 */
  async start(id: string, token: string, config: RuntimeConfig) {
    if (this.closing)
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', '运行时正在关闭');
    const grant = await this.db.transaction(async (client) => {
      const context = await this.authorized(client, id, token, true);
      // 基准预算由服务端固定，不能由错误配置的 worker 放宽；先记录实际构建身份再执行。
      const benchmark = (
        await client.query(
          'SELECT b.agent_release,r.family FROM pr_benchmark_cases b JOIN pr_benchmark_runs r ON r.id=b.run_id WHERE b.task_id=$1',
          [context.task_id],
        )
      ).rows[0];
      if (!benchmark && config.maxTurns > 200)
        throw new ApiError(
          400,
          'INVALID_RUNTIME_CONFIG',
          '普通任务模型轮次不能超过 200',
        );
      const limits =
        benchmark &&
        benchmarkRuntimeLimits(benchmark.family, context.definition);
      if (
        benchmark &&
        (!benchmark.agent_release ||
          Object.entries(limits!).some(
            ([key, value]) => config[key as keyof RuntimeConfig] !== value,
          ))
      )
        throw new ApiError(
          409,
          'BENCHMARK_CONFIG_CONFLICT',
          '基准要求登记构建身份并使用固定执行预算',
        );
      await client.query(
        "INSERT INTO pr_execution_runtimes(execution_id,state,config) VALUES($1,'ACTIVE',$2) ON CONFLICT DO NOTHING",
        [id, config],
      );
      const row = (
        await client.query(
          'SELECT state,config FROM pr_execution_runtimes WHERE execution_id=$1',
          [id],
        )
      ).rows[0]!;
      if (canonical(row.config) !== canonical(config))
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '运行时配置已冻结');
      if (row.state !== 'ACTIVE')
        throw new ApiError(410, 'EXECUTION_RUNTIME_LOST', '运行时不能重新启动');
      return {
        id,
        task: context.definition,
        leaseToken: token,
        leaseExpiresAt: context.lease_expires_at.toISOString(),
        taskDeadlineAt: context.deadline_at.toISOString(),
        sessionId: context.session_id,
        nodeId: context.node_id,
        state: 'STARTING',
        runtimeVersion: 1,
      } satisfies ExecutionGrant;
    });
    if (!this.active.has(id)) {
      const stop = new AbortController();
      const running = Promise.resolve()
        .then(() =>
          execute(
            { ...config, apiUrl: this.publicUrl },
            this.driver.ports(grant),
            { decide: (input, signal) => this.decide(grant, input, signal) },
            grant,
            stop.signal,
          ),
        )
        .then(async (report) => {
          await this.db.transaction(async (client) => {
            await client.query(
              "UPDATE pr_execution_runtimes SET state='FINISHED',result_report=$2,updated_at=clock_timestamp() WHERE execution_id=$1 AND state='ACTIVE'",
              [id, report],
            );
            await settleRuntimeOperations(client, id);
          });
        })
        .catch(async () => {
          await this.fail(id);
        })
        .finally(() => {
          this.active.delete(id);
        });
      this.active.set(id, { stop, running });
      void running.catch(() => {});
    }
    return { started: true, runtimeVersion: 1 };
  }

  /** GET 只返回当前进程仍可服务的一帧；读取不代替真实 worker 心跳。 */
  async view(
    id: string,
    token: string,
    afterRevision: number,
  ): Promise<RuntimeView> {
    return this.db.transaction(async (client) => {
      await client.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      await this.authorized(client, id, token);
      const row = (
        await client.query(
          'SELECT r.state,coalesce(r.result_report,t.report) AS report FROM pr_execution_runtimes r JOIN pr_executions e ON e.id=r.execution_id JOIN pr_tasks t ON t.id=e.task_id WHERE r.execution_id=$1',
          [id],
        )
      ).rows[0];
      if (!row)
        throw new ApiError(409, 'RUNTIME_NOT_STARTED', '运行时尚未启动');
      const decisions = (
        await client.query(
          "SELECT id,revision,context FROM pr_runtime_decisions WHERE execution_id=$1 AND state='WAITING' AND revision>$2 ORDER BY revision LIMIT 1",
          [id, afterRevision],
        )
      ).rows;
      return {
        state: row.state,
        decisions: decisions.map((d) => ({
          id: d.id,
          revision: Number(d.revision),
          ...d.context,
        })),
        report: row.report,
      };
    });
  }

  /** 新上下文在数据库分配版本；并行 tab 的决定彼此独立，不共用单一可覆盖槽位。 */
  private async decide(
    grant: ExecutionGrant,
    input: DecisionInput,
    signal: AbortSignal,
  ): Promise<DecisionOutput> {
    signal.throwIfAborted();
    const id = randomUUID();
    input.traceId = id;
    const frame: Omit<RuntimeDecisionFrame, 'id' | 'revision'> = {
      text: input.text,
      modelDeadlineAt:
        input.modelDeadline === undefined
          ? null
          : new Date(
              Date.now() + Math.max(0, input.modelDeadline - performance.now()),
            ).toISOString(),
    };
    if (input.image) {
      const hash = digest(Buffer.from(input.image.split(',')[1]!, 'base64'));
      const artifact = input.context?.page.artifactRefs.find(
        (ref) => ref.kind === 'SCREENSHOT' && ref.sha256 === hash,
      );
      if (!artifact)
        throw new ExecutionFault('EVIDENCE_MISMATCH', '当前截图缺少可追溯证据');
      frame.imageArtifact = {
        id: artifact.artifactId,
        sha256: hash,
      };
    }
    // 先注册回调再发布快照，极快 worker 也不能看到尚未可处理的决定。
    let resolve!: (value: DecisionOutput) => void,
      reject!: (error: unknown) => void;
    const result = new Promise<DecisionOutput>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // 在数据库发布期间也立即安装拒绝处理，避免撤权形成未处理 rejection。
    void result.catch(() => {});
    this.pending.set(id, { input, resolve, reject });
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try {
      await this.db.transaction(async (client) => {
        const context = await this.authorized(
          client,
          grant.id,
          grant.leaseToken,
          true,
        );
        if (context.control_mode !== 'AUTO')
          throw new ExecutionFault('CONTROL_CHANGED', '控制权已变化');
        const row = (
          await client.query(
            "UPDATE pr_execution_runtimes SET revision=revision+1,updated_at=clock_timestamp() WHERE execution_id=$1 AND state='ACTIVE' RETURNING revision",
            [grant.id],
          )
        ).rows[0];
        if (!row)
          throw new ExecutionFault('EXECUTION_RUNTIME_LOST', '运行时已终止');
        await client.query(
          "INSERT INTO pr_runtime_decisions(id,execution_id,revision,state,context,control_revision,auth_revision) VALUES($1,$2,$3,'WAITING',$4,$5,$6)",
          [
            id,
            grant.id,
            row.revision,
            frame,
            context.control_revision,
            context.auth_revision,
          ],
        );
      });
      signal.throwIfAborted();
      return await result;
    } catch (error) {
      // 决定发布前的撤权也保留领域分类，不能退化为通用 Agent 异常。
      if (error instanceof ApiError)
        throw new ExecutionFault(error.code, error.message, error.statusCode);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      this.pending.delete(id);
      await this.db.query(
        "UPDATE pr_runtime_decisions SET state='ABORTED' WHERE id=$1 AND state='WAITING'",
        [id],
      );
    }
  }

  /** 每帧有独立版本与内容摘要；重试不能再次解析或再次派发已经接收的决定。 */
  async mutate(
    id: string,
    token: string,
    decisionId: string,
    body: Exclude<RuntimeRequest, { type: 'start' }>,
  ) {
    const phase =
      body.type === 'decision'
        ? 'input_hash'
        : body.type === 'trace_start'
          ? 'trace_start_hash'
          : 'trace_finish_hash';
    const hash = digest(canonical(body));
    let repeated = false,
      changed = false;
    await this.db.transaction(async (client) => {
      const context = await this.authorized(client, id, token, false, true);
      const row = (
        await client.query(
          'SELECT * FROM pr_runtime_decisions WHERE id=$1 AND execution_id=$2 FOR UPDATE',
          [decisionId, id],
        )
      ).rows[0];
      if (!row)
        throw new ApiError(404, 'RUNTIME_DECISION_MISSING', '决定不存在');
      if (Number(row.revision) !== body.revision)
        throw new ApiError(409, 'REVISION_CONFLICT', '决定版本已变化');
      if (row[phase]) {
        if (row[phase] !== hash)
          throw new ApiError(
            409,
            'IDEMPOTENCY_CONFLICT',
            '同一决定阶段已绑定另一份输入',
          );
        repeated = true;
        return;
      }
      if (body.type !== 'trace_finish')
        await this.authorized(client, id, token, true);
      if (
        body.type !== 'trace_finish' &&
        (row.state !== 'WAITING' || !this.pending.has(decisionId))
      )
        throw new ApiError(410, 'EXECUTION_RUNTIME_LOST', '决定已经结束');
      if (
        body.type !== 'trace_finish' &&
        (Number(row.control_revision) !== context.control_revision ||
          Number(row.auth_revision) !== context.auth_revision ||
          context.control_mode !== 'AUTO')
      ) {
        await client.query(
          "UPDATE pr_runtime_decisions SET state='ABORTED' WHERE id=$1",
          [decisionId],
        );
        changed = true;
        return;
      }
      if (body.type === 'trace_finish' && !row.trace_start_done)
        throw new ApiError(409, 'MODEL_TRACE_REQUIRED', '先存档真实模型请求');
      if (
        body.type === 'decision' &&
        (!row.trace_start_done || !row.trace_finish_done)
      )
        throw new ApiError(
          409,
          'MODEL_TRACE_REQUIRED',
          '决定必须具有已完成的模型调用记录',
        );
      await client.query(
        `UPDATE pr_runtime_decisions SET ${phase}=$2${body.type === 'decision' ? ",state='ACCEPTED',outcome=$3" : ''} WHERE id=$1`,
        body.type === 'decision'
          ? [decisionId, hash, body.outcome]
          : [decisionId, hash],
      );
    });
    const pending = this.pending.get(decisionId);
    if (changed) {
      pending?.reject(
        new ExecutionFault('CONTROL_CHANGED', '控制或认证版本已变化'),
      );
      throw new ApiError(409, 'CONTROL_CHANGED', '旧上下文不可继续执行');
    }
    if (body.type === 'decision') {
      if (!repeated && pending) {
        if ('output' in body.outcome)
          pending.resolve(body.outcome.output as DecisionOutput);
        else
          pending.reject(
            new ExecutionFault(
              body.outcome.error.code,
              body.outcome.error.message ?? '模型未交付有效决定',
              body.outcome.error.status,
            ),
          );
      }
    } else if (pending) {
      try {
        if (body.type === 'trace_start') {
          if (!pending.trace)
            pending.trace = (async () => {
              const receipt = await pending.input.traceRequest!(body.request);
              pending.traceModel = body.request.model;
              pending.input.recordRequest?.(body.request.model);
              await this.db.query(
                'UPDATE pr_runtime_decisions SET trace_start_done=true WHERE id=$1',
                [decisionId],
              );
              return receipt;
            })();
          await pending.trace;
        } else {
          if (!pending.finish)
            pending.finish = (async () => {
              const receipt = await pending.trace!;
              await receipt(body.result);
              pending.input.recordUsage?.(
                pending.traceModel!,
                body.result.promptTokens ?? 0,
                body.result.completionTokens ?? 0,
              );
              await this.db.query(
                'UPDATE pr_runtime_decisions SET trace_finish_done=true WHERE id=$1',
                [decisionId],
              );
            })();
          await pending.finish;
        }
      } catch (error) {
        pending.reject(error);
        throw new ApiError(
          503,
          'MODEL_TRACE_FAILED',
          '模型请求或结果未能持久化',
        );
      }
    } else if (body.type === 'trace_finish') {
      await this.driver.finishTrace(id, token, decisionId, body.result);
      await this.db.query(
        'UPDATE pr_runtime_decisions SET trace_finish_done=true WHERE id=$1',
        [decisionId],
      );
    } else {
      const row = (
        await this.db.query(
          'SELECT trace_start_done,trace_finish_done FROM pr_runtime_decisions WHERE id=$1',
          [decisionId],
        )
      ).rows[0];
      if (
        !repeated ||
        !row?.[
          body.type === 'trace_start' ? 'trace_start_done' : 'trace_finish_done'
        ]
      )
        throw new ApiError(410, 'EXECUTION_RUNTIME_LOST', '运行时已终止');
    }
    return { accepted: true, decisionId, revision: body.revision };
  }

  /** 保留部分事实并关闭原执行，不重建业务驱动。 */
  private async fail(id: string) {
    await this.db.transaction(async (client) => {
      const context = await executionContext(client, id);
      if (context.task_state === 'RUNNING')
        await stopExecution(client, context, 'ERROR', 'EXECUTION_RUNTIME_LOST');
      await client.query(
        "UPDATE pr_execution_runtimes SET state='LOST',error_code='EXECUTION_RUNTIME_LOST',updated_at=clock_timestamp() WHERE execution_id=$1",
        [id],
      );
      await settleRuntimeOperations(client, id);
    });
  }

  /** 先撤销驱动，再等待它保留已有报告和停止事实；数据库关闭必须晚于此方法。 */
  async close() {
    this.closing = true;
    const running = [...this.active.values()];
    for (const runtime of running)
      runtime.stop.abort(
        new ExecutionFault('EXECUTION_RUNTIME_LOST', '控制面运行时正在关闭'),
      );
    await Promise.allSettled(running.map((runtime) => runtime.running));
  }
}
