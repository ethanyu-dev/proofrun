import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  validateExternalExecutionResult,
  type ExternalExecutionRequest,
} from '@proofrun/contracts';
import { allowedDecisionTypes } from '@proofrun/execution-core/execution/allowed-decisions';
import type { DecisionContextData } from '@proofrun/execution-core/execution/context';
import type { Database } from '../../db.js';
import type { ApiConfig } from '../../config.js';
import { ApiError, canonical, digest } from '../../domain.js';
import type {
  PublicCredential,
  PublicScope,
  PublicChannel,
} from '../public-execution/auth.js';
import {
  bindOwned,
  checkBinding,
  lockPublic,
  requireOwned,
} from '../public-execution/ledger.js';
import type { Coordinator } from '../scheduling/coordinator.js';
import { executionContext, stopExecution } from '../scheduling/state.js';
import { consumeStepBudget } from '../scheduling/step-budget.js';
import { ExternalEngine } from './engine.js';

/** 默认活动窗口独立于任务/账号硬期限；普通 GET 绝不延长。 */
export const EXTERNAL_IDLE_MS = 300000;
/** 只允许公开的原有动作；环境意图和原始 Cookie 写入从未开放。 */
const PRIVATE_DECISIONS = new Set([
  'verification.environment',
  'browser.cookies.clear',
]);
/** 输出投影也校验契约，避免内部字段意外成为外部授权材料。 */
function publicResult<T extends Record<string, unknown>>(value: T): T {
  if (!validateExternalExecutionResult(value))
    throw new ApiError(
      503,
      'INVALID_PUBLIC_RESULT',
      '外部执行结果不符合公共契约',
    );
  return value;
}
/** 幂等账本只投影回执字段，输入正文不存入公开操作记录。 */
interface OperationRow {
  /** 调用方提供的稳定操作身份。 */
  id: string;
  /** 平台产生的控制句柄和运行身份，不是授权令牌。 */
  controller_id: string;
  run_id: string;
  /** 处理状态与已保存进度分别表达，失败不抹掉进度。 */
  state: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
  progress_applied: boolean;
  /** 稳定错误码及效果摘要；没有内部错误正文。 */
  error_code: string | null;
  result: { effect?: string; controllerId?: string } | null;
}
/** 控制行只在领域内部使用，永不直接返回调用方。 */
interface Controller {
  /** 平台控制句柄、冻结运行与调用方归属。 */
  id: string;
  run_id: string;
  principal_id: string;
  /** 生命周期和内部执行关联，内部执行身份不投影给外部。 */
  state: string;
  execution_id: string | null;
  /** 可操作快照版本，数据库 bigint 由 pg 作为字符串读取。 */
  revision: string;
  context: DecisionContextData | null;
  /** 与执行状态同时冻结的控制/认证代次，变化时整帧失效。 */
  control_revision: string | null;
  auth_revision: string | null;
  /** 活动期限、决定计数和终止原因分别保存。 */
  idle_deadline_at: Date;
  decision_calls: number;
  reason_code: string | null;
}
/** 外部控制 API 管理归属、版本和持久操作；业务状态机由共享引擎负责。 */
export class ExternalExecution {
  private closing = false;
  readonly idleMs: number;
  constructor(
    private readonly db: Database,
    private readonly coordinator: Coordinator,
    readonly engine: ExternalEngine,
    config: ApiConfig,
  ) {
    this.idleMs = config.externalIdleMs ?? EXTERNAL_IDLE_MS;
  }
  /** 相同 principal 可跨两套接入面，但每次调用仍必须持有本动作的 scope。 */
  permission(
    principal: PublicCredential,
    scope: PublicScope,
    channel?: PublicChannel,
  ) {
    if (
      !principal.scopes.includes(scope) ||
      (channel && !principal.channels.includes(channel))
    )
      throw new ApiError(403, 'SCOPE_FORBIDDEN', '凭据未授权此执行操作');
  }
  /** 先核实归属再锁执行和控制行，锁序与共享驱动一致。 */
  private async controller(
    client: PoolClient,
    principal: string,
    id: string,
    lock = false,
  ): Promise<Controller> {
    const row = (
      await client.query<Controller>(
        'SELECT * FROM pr_external_controllers WHERE id=$1 AND principal_id=$2',
        [id, principal],
      )
    ).rows[0];
    if (!row)
      throw new ApiError(404, 'RESOURCE_NOT_FOUND', '控制绑定不存在或不可访问');
    await requireOwned(client, principal, { kind: 'run', id: row.run_id });
    if (lock) {
      if (row.execution_id) await executionContext(client, row.execution_id);
      else
        await client.query('SELECT id FROM pr_tasks WHERE id=$1 FOR UPDATE', [
          row.run_id,
        ]);
    }
    return lock
      ? (
          await client.query<Controller>(
            'SELECT * FROM pr_external_controllers WHERE id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0]!
      : row;
  }
  /** 适配器仅按已归属且不可变的任务种类限定工具，不能由调用参数声称类型。 */
  async kind(principal: PublicCredential, id: string): Promise<PublicChannel> {
    return this.db.transaction(async (client) => {
      const row = await this.controller(client, principal.principalId, id);
      const task = (
        await client.query('SELECT definition FROM pr_tasks WHERE id=$1', [
          row.run_id,
        ])
      ).rows[0];
      return task.definition.taskKind === 'browser'
        ? 'browser'
        : 'verification';
    });
  }
  /** 已撤销/过期绑定不能经 touch 或重复 bind 复活。 */
  private active(row: Controller) {
    if (row.state !== 'ACTIVE')
      throw new ApiError(410, 'EXECUTION_ENDED', '控制绑定已经结束');
    if (row.idle_deadline_at.getTime() <= Date.now())
      throw new ApiError(410, 'CONTROLLER_EXPIRED', '控制绑定活动期限已过');
  }
  /** 同一操作键绑定完整路径和输入；失败回执也不能换参数重送。 */
  private async old(
    client: PoolClient,
    principal: string,
    id: string,
    input: unknown,
  ) {
    await lockPublic(client, `external-operation:${principal}:${id}`);
    if (
      (
        await client.query(
          "SELECT 1 FROM pr_public_calls WHERE principal_id=$1 AND namespace='operation' AND call_key=$2",
          [principal, id],
        )
      ).rowCount
    )
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '操作键已用于任务操作');
    const row = (
      await client.query(
        'SELECT * FROM pr_external_operations WHERE principal_id=$1 AND id=$2',
        [principal, id],
      )
    ).rows[0];
    if (row) {
      await requireOwned(client, principal, { kind: 'run', id: row.run_id });
      if (row.input_hash !== digest(canonical(input)))
        throw new ApiError(
          409,
          'IDEMPOTENCY_CONFLICT',
          '操作身份已绑定其他输入',
        );
    }
    return row;
  }
  /** 不回传命令身份、内部执行令牌或节点信息；回执与最终报告分别读取。 */
  private receipt(row: OperationRow) {
    return publicResult({
      kind: 'operation',
      data: {
        operationId: row.id,
        controllerId: row.controller_id,
        runId: row.run_id,
        status: row.state,
        progressApplied: row.progress_applied,
        effect:
          row.result?.effect ??
          (row.state === 'RUNNING' ? 'UNKNOWN' : 'NOT_STARTED'),
        error: row.error_code ? { code: row.error_code } : null,
        ...(row.result?.controllerId
          ? { controllerId: row.result.controllerId }
          : {}),
      },
    });
  }
  /** 查询不会续租，且已删除运行仍按原归属策略拒绝访问。 */
  async operation(principal: PublicCredential, id: string) {
    this.permission(principal, 'runs:read');
    const row = (
      await this.db.query<OperationRow>(
        'SELECT * FROM pr_external_operations WHERE principal_id=$1 AND id=$2',
        [principal.principalId, id],
      )
    ).rows[0];
    if (!row) return null;
    await requireOwned(this.db, principal.principalId, {
      kind: 'run',
      id: row.run_id,
    });
    return this.receipt(row);
  }

  /** 通用浏览器创建和绑定同事务完成，不接受平台预算、身份材料或未知会话配置。 */
  async open(
    principal: PublicCredential,
    input: Extract<ExternalExecutionRequest, { type: 'open' }>,
  ) {
    this.permission(principal, 'browser:control', 'browser');
    return this.db.transaction(async (client) => {
      const request = { open: input };
      const old = await this.old(
        client,
        principal.principalId,
        input.operationId,
        request,
      );
      if (old) return this.receipt(old);
      const runId = `browser-external-${digest(canonical([principal.principalId, input.taskKey]))}`;
      await lockPublic(client, runId);
      await checkBinding(client, principal.principalId, {
        kind: 'run',
        id: runId,
      });
      const existing = (
        await client.query('SELECT executor_kind FROM pr_tasks WHERE id=$1', [
          runId,
        ])
      ).rows[0];
      if (existing && existing.executor_kind !== 'external')
        throw new ApiError(
          409,
          'RUN_EXECUTOR_CONFLICT',
          '运行已绑定内置执行者',
        );
      await this.coordinator.submitBrowserInTransaction(
        { taskId: runId, url: input.url, objective: input.objective },
        client,
      );
      await client.query(
        "UPDATE pr_tasks SET executor_kind='external',runtime_version=1 WHERE id=$1",
        [runId],
      );
      await bindOwned(client, principal.principalId, {
        kind: 'run',
        id: runId,
      });
      const row = await this.bindRow(client, principal.principalId, runId);
      return this.saveSimple(
        client,
        principal.principalId,
        input.operationId,
        request,
        row,
        'open',
      );
    });
  }
  /** 只有匹配的 external 运行可绑定，已有绑定不延长期限。 */
  private async bindRow(
    client: PoolClient,
    principal: string,
    runId: string,
  ): Promise<Controller> {
    const task = (
      await client.query(
        'SELECT state,executor_kind,binding_deadline_at FROM pr_tasks WHERE id=$1 FOR UPDATE',
        [runId],
      )
    ).rows[0];
    if (task.executor_kind !== 'external')
      throw new ApiError(
        409,
        'RUN_EXECUTOR_CONFLICT',
        '只能绑定 external 运行',
      );
    const prior = (
      await client.query<Controller>(
        'SELECT * FROM pr_external_controllers WHERE run_id=$1',
        [runId],
      )
    ).rows[0];
    if (prior) {
      this.active(prior);
      return prior;
    }
    if (
      task.state !== 'QUEUED' ||
      (task.binding_deadline_at &&
        task.binding_deadline_at.getTime() <= Date.now())
    )
      throw new ApiError(410, 'EXECUTION_ENDED', '运行已结束或超过绑定期限');
    return (
      await client.query<Controller>(
        "INSERT INTO pr_external_controllers(id,run_id,principal_id,state,idle_deadline_at) VALUES($1,$2,$3,'ACTIVE',clock_timestamp()+$4*interval '1 millisecond') RETURNING *",
        [randomUUID(), runId, principal, this.idleMs],
      )
    ).rows[0]!;
  }
  /** 正式验证只绑定已冻结 external 的运行，不隐式创建或重跑。 */
  async bind(
    principal: PublicCredential,
    runId: string,
    input: Extract<ExternalExecutionRequest, { type: 'bind' }>,
  ) {
    this.permission(principal, 'verification:control', 'verification');
    return this.db.transaction(async (client) => {
      const request = { runId, ...input };
      const old = await this.old(
        client,
        principal.principalId,
        input.operationId,
        request,
      );
      if (old) return this.receipt(old);
      await requireOwned(client, principal.principalId, {
        kind: 'run',
        id: runId,
      });
      const row = await this.bindRow(client, principal.principalId, runId);
      return this.saveSimple(
        client,
        principal.principalId,
        input.operationId,
        request,
        row,
        'bind',
      );
    });
  }
  /** 简单控制变更与回执在同一事务提交。 */
  private async saveSimple(
    client: PoolClient,
    principal: string,
    id: string,
    input: unknown,
    row: Controller,
    kind: string,
  ) {
    const saved = (
      await client.query(
        "INSERT INTO pr_external_operations(principal_id,id,input_hash,controller_id,run_id,kind,state,result) VALUES($1,$2,$3,$4,$5,$6,'SUCCEEDED',$7) RETURNING *",
        [
          principal,
          id,
          digest(canonical(input)),
          row.id,
          row.run_id,
          kind,
          { controllerId: row.id, effect: 'NOT_STARTED' },
        ],
      )
    ).rows[0];
    return this.receipt(saved);
  }
  /** 外部视图转换预算名称；平台模型用量保持不可观测，允许动作来自共享规则。 */
  async view(principal: PublicCredential, id: string) {
    this.permission(principal, 'runs:read');
    return this.db.transaction(async (client) => {
      await client.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      const row = await this.controller(client, principal.principalId, id);
      const task = (
        await client.query(
          'SELECT state,report,definition FROM pr_tasks WHERE id=$1',
          [row.run_id],
        )
      ).rows[0]!;
      const execution = row.execution_id
        ? await executionContext(client, row.execution_id, { lock: false })
        : null;
      const current = row.context;
      const timing = this.engine.timing(id, Number(row.revision));
      const ready =
        row.state === 'ACTIVE' &&
        row.idle_deadline_at.getTime() > Date.now() &&
        !!current &&
        !!timing &&
        !!execution &&
        execution.control_mode === 'AUTO' &&
        Number(row.control_revision) === execution.control_revision &&
        Number(row.auth_revision) === execution.auth_revision &&
        this.engine.waiting(id);
      const context = current
        ? {
            ...structuredClone(current),
            budget: {
              actions: current.budget.actions,
              timeMs: current.budget.timeMs,
              ...timing,
              timingState: timing ? 'live' : 'inactive',
              decisionCalls: current.budget.modelCalls,
            },
          }
        : null;
      if (context && current?.state.settlement === 'budget')
        context.feedback.push({
          code: 'SETTLEMENT_REQUIRED',
          message:
            '已进入预算收尾；禁止浏览器操作。先保存已取得的部分结论，再完成或阻塞当前步骤；请以 decisionDeadlineAt 为本轮提交期限。',
        });
      const pending = (
        await client.query(
          "SELECT id FROM pr_external_operations WHERE controller_id=$1 AND state='RUNNING'",
          [id],
        )
      ).rows[0];
      return publicResult({
        kind: 'controller',
        data: {
          controllerId: id,
          runId: row.run_id,
          revision: Number(row.revision),
          state: row.state,
          runState: task.state,
          sessionState: execution?.session_state ?? 'QUEUED',
          controlMode: execution?.control_mode ?? 'AUTO',
          idleDeadlineAt: row.idle_deadline_at.toISOString(),
          closureVerified: execution?.closure_verified ?? true,
          pendingOperation: pending?.id ?? null,
          context,
          allowedActions: ready
            ? allowedDecisionTypes(current!).filter(
                (type) =>
                  principal.scopes.includes(
                    current!.task.kind === 'browser' ||
                      type.startsWith('browser.') ||
                      type.startsWith('network.') ||
                      type === 'context.read'
                      ? 'browser:control'
                      : 'verification:control',
                  ) &&
                  principal.channels.includes(
                    current!.task.kind === 'browser' ||
                      type.startsWith('browser.') ||
                      type.startsWith('network.') ||
                      type === 'context.read'
                      ? 'browser'
                      : 'verification',
                  ) &&
                  !PRIVATE_DECISIONS.has(type) &&
                  !(
                    type === 'browser.act' &&
                    current!.state.phase === 'CHECKING'
                  ),
              )
            : [],
          nextAction:
            row.state !== 'ACTIVE'
              ? 'READ_REPORT'
              : execution?.control_mode && execution.control_mode !== 'AUTO'
                ? 'HUMAN_REQUIRED'
                : ready
                  ? 'ACT'
                  : 'WAIT',
          executor: {
            kind: 'external',
            judgmentSource: 'external_agent',
            usageSource: 'unavailable',
            decisionCalls: row.decision_calls,
            modelCalls: null,
            promptTokens: null,
            completionTokens: null,
          },
          report: task.report,
        },
      });
    });
  }
  /** touch 不推进阶段或重置预算，close 只停止本运行；资源关闭事实由节点确认。 */
  async control(
    principal: PublicCredential,
    id: string,
    input: Extract<ExternalExecutionRequest, { type: 'touch' | 'close' }>,
  ) {
    const result = await this.db.transaction(async (client) => {
      const request = { controllerId: id, ...input };
      const owned = await this.controller(client, principal.principalId, id);
      const definition = (
        await client.query('SELECT definition FROM pr_tasks WHERE id=$1', [
          owned.run_id,
        ])
      ).rows[0].definition;
      const isBrowser = definition.taskKind === 'browser';
      this.permission(
        principal,
        isBrowser ? 'browser:control' : 'verification:control',
        isBrowser ? 'browser' : 'verification',
      );
      const old = await this.old(
        client,
        principal.principalId,
        input.operationId,
        request,
      );
      if (old) return this.receipt(old);
      const row = await this.controller(
        client,
        principal.principalId,
        id,
        true,
      );
      const task = (
        await client.query('SELECT definition FROM pr_tasks WHERE id=$1', [
          row.run_id,
        ])
      ).rows[0]!;
      const kind =
        task.definition.taskKind === 'browser' ? 'browser' : 'verification';
      this.permission(
        principal,
        kind === 'browser' ? 'browser:control' : 'verification:control',
        kind,
      );
      this.active(row);
      if (input.type === 'touch')
        await client.query(
          "UPDATE pr_external_controllers SET idle_deadline_at=clock_timestamp()+$2*interval '1 millisecond' WHERE id=$1",
          [id, this.idleMs],
        );
      else {
        await this.coordinator.cancelInTransaction(row.run_id, client);
        await client.query(
          "UPDATE pr_external_controllers SET state='CLOSED',reason_code='TASK_CANCELLED',revision=revision+1 WHERE id=$1",
          [id],
        );
      }
      return this.saveSimple(
        client,
        principal.principalId,
        input.operationId,
        request,
        row,
        input.type,
      );
    });
    if (input.type === 'close') this.engine.abort(id, 'TASK_CANCELLED');
    return result;
  }

  /** 每个决定先原子登记，版本/观察/控制代次必须匹配；浏览器和验证权限分别检查。 */
  async decide(
    principal: PublicCredential,
    id: string,
    input: Extract<ExternalExecutionRequest, { type: 'decide' }>,
  ) {
    let accepted = false,
      refresh = false;
    const result = await this.db.transaction(async (client) => {
      const request = { controllerId: id, ...input };
      const owned = await this.controller(client, principal.principalId, id);
      const definition = (
        await client.query('SELECT definition FROM pr_tasks WHERE id=$1', [
          owned.run_id,
        ])
      ).rows[0].definition;
      const isBrowser =
        definition.taskKind === 'browser' ||
        (input.type === 'decide' &&
          (input.decision.type.startsWith('browser.') ||
            input.decision.type.startsWith('network.') ||
            input.decision.type === 'context.read'));
      this.permission(
        principal,
        isBrowser ? 'browser:control' : 'verification:control',
        isBrowser ? 'browser' : 'verification',
      );
      if (
        definition.taskKind !== 'browser' &&
        input.decision.progress &&
        Object.values(input.decision.progress).some((items) => items?.length)
      )
        this.permission(principal, 'verification:control', 'verification');
      const old = await this.old(
        client,
        principal.principalId,
        input.operationId,
        request,
      );
      if (old) return this.receipt(old);
      const row = await this.controller(
        client,
        principal.principalId,
        id,
        true,
      );
      this.active(row);
      const context = row.context;
      if (!context || !row.execution_id)
        throw new ApiError(409, 'EXECUTION_NOT_READY', '尚未取得可操作上下文');

      const execution = await executionContext(client, row.execution_id);
      if (execution.task_state !== 'RUNNING')
        throw new ApiError(410, 'EXECUTION_ENDED', '运行已经结束');
      if (
        execution.control_mode !== 'AUTO' ||
        Number(row.control_revision) !== execution.control_revision ||
        Number(row.auth_revision) !== execution.auth_revision
      ) {
        refresh = true;
        return null;
      }
      if (
        (
          await client.query(
            "SELECT 1 FROM pr_external_operations WHERE controller_id=$1 AND state='RUNNING'",
            [id],
          )
        ).rowCount
      )
        throw new ApiError(409, 'OPERATION_IN_FLIGHT', '已有决定正在处理');
      if (Number(row.revision) !== input.expectedRevision)
        throw new ApiError(409, 'REVISION_CONFLICT', '上下文版本已变化');
      if (!this.engine.waiting(id))
        throw new ApiError(
          409,
          'EXECUTION_NOT_READY',
          '执行器正在推进，请重新读取上下文',
        );
      if (input.observationId !== context.page.observationId)
        throw new ApiError(409, 'STALE_OBSERVATION', '必须基于当前观察提交');
      if (context.task.stepId !== input.stepId)
        throw new ApiError(409, 'STEP_CONFLICT', '步骤身份与当前上下文不符');
      if (
        PRIVATE_DECISIONS.has(input.decision.type) ||
        !allowedDecisionTypes(context).includes(input.decision.type)
      )
        throw new ApiError(422, 'ACTION_NOT_ALLOWED', '当前阶段不允许此操作');
      if (
        input.decision.type === 'browser.act' &&
        context.state.phase === 'CHECKING'
      )
        throw new ApiError(
          422,
          'ACTION_NOT_ALLOWED',
          '检查阶段只允许观察和核验',
        );
      await consumeStepBudget(client, execution, 'modelCalls', input.stepId);
      await client.query(
        "UPDATE pr_external_controllers SET decision_calls=decision_calls+1,revision=revision+1,idle_deadline_at=clock_timestamp()+$2*interval '1 millisecond' WHERE id=$1",
        [id, this.idleMs],
      );
      const rowResult = (
        await client.query(
          "INSERT INTO pr_external_operations(principal_id,id,input_hash,controller_id,run_id,kind,state,result) VALUES($1,$2,$3,$4,$5,'decide','RUNNING',$6) RETURNING *",
          [
            principal.principalId,
            input.operationId,
            digest(canonical(request)),
            id,
            row.run_id,
            {
              hasProgress:
                !!input.decision.progress &&
                Object.values(input.decision.progress).some(
                  (items) => items?.length,
                ),
            },
          ],
        )
      ).rows[0];
      accepted = true;
      return this.receipt(rowResult);
    });
    if (refresh) {
      this.engine.refresh(id);
      throw new ApiError(
        409,
        'CONTROL_CHANGED',
        '旧控制或身份上下文不能继续使用',
      );
    }
    if (accepted) {
      try {
        this.engine.accept(
          id,
          input.operationId,
          input.decision,
          input.expectedRevision,
        );
      } catch (error) {
        // 版本/期限在事务期间变化时尚未唤醒驱动，可明确未开始；运行时丢失仍保守保留未知。
        const notStarted =
          error instanceof ApiError && error.code === 'REVISION_CONFLICT';
        await this.db.query(
          "UPDATE pr_external_operations SET state=$3,error_code=$4,result=jsonb_build_object('effect',$5::text) WHERE controller_id=$1 AND id=$2 AND state='RUNNING'",
          [
            id,
            input.operationId,
            notStarted ? 'FAILED' : 'UNKNOWN',
            notStarted ? 'REVISION_CONFLICT' : 'EXECUTION_RUNTIME_LOST',
            notStarted ? 'NOT_STARTED' : 'UNKNOWN',
          ],
        );
        throw error;
      }
    }
    return result!;
  }

  /** 启动恢复只能终止旧进程栈；同一控制句柄不能恢复动作或重新领取。 */
  async recover() {
    await this.db.query(
      "UPDATE pr_external_controllers SET state='LOST',reason_code='EXECUTION_RUNTIME_LOST',revision=revision+1 WHERE state='ACTIVE' AND execution_id IS NOT NULL",
    );
    await this.db.query(
      "UPDATE pr_external_operations SET state='UNKNOWN',error_code='EXECUTION_RUNTIME_LOST',result=jsonb_build_object('effect','UNKNOWN') WHERE state='RUNNING'",
    );
  }
  /** supervisor 是外部执行唯一续租者；失联、取消或硬期限到期后停止，不切到内置 Agent。 */
  async tick() {
    if (this.closing) return;
    await this.db.query(
      "UPDATE pr_tasks SET state='TIMED_OUT',finished_at=clock_timestamp(),error=jsonb_build_object('code','EXTERNAL_BINDING_TIMEOUT','message','等待外部控制绑定超时') WHERE executor_kind='external' AND state='QUEUED' AND binding_deadline_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM pr_external_controllers c WHERE c.run_id=pr_tasks.id)",
    );
    const rows = (
      await this.db.query<Controller>(
        "SELECT * FROM pr_external_controllers WHERE state='ACTIVE' ORDER BY created_at",
      )
    ).rows;
    for (const row of rows) {
      const grant = this.engine.grant(row.id);
      const task = (
        await this.db.query('SELECT state FROM pr_tasks WHERE id=$1', [
          row.run_id,
        ])
      ).rows[0];
      if (!['QUEUED', 'RUNNING'].includes(task?.state)) {
        if (grant) this.engine.abort(row.id, 'EXECUTION_ENDED');
        else
          await this.db.query(
            "UPDATE pr_external_controllers SET state='CLOSED',revision=revision+1 WHERE id=$1 AND state='ACTIVE'",
            [row.id],
          );
        continue;
      }
      const execution = grant
        ? await this.coordinator
            .execution(grant.id, grant.leaseToken)
            .catch((error) => {
              if (!(error instanceof ApiError)) throw error;
              this.engine.abort(row.id, 'EXECUTION_EXPIRED');
              return null;
            })
        : null;
      if (grant && !execution) continue;
      if (
        grant &&
        this.engine.waiting(row.id) &&
        (execution?.controlMode !== 'AUTO' ||
          Number(row.control_revision) !== execution?.controlRevision ||
          Number(row.auth_revision) !== execution?.authRevision)
      )
        this.engine.refresh(row.id);
      if (
        grant &&
        (execution?.controlMode !== 'AUTO' || !this.engine.waiting(row.id))
      )
        await this.db.query(
          "UPDATE pr_external_controllers SET idle_deadline_at=clock_timestamp()+$2*interval '1 millisecond' WHERE id=$1 AND state='ACTIVE'",
          [row.id, this.idleMs],
        );
      else if (row.idle_deadline_at.getTime() <= Date.now()) {
        const expired = await this.db.transaction(async (client) => {
          const locked = await this.controller(
            client,
            row.principal_id,
            row.id,
            true,
          );
          if (
            locked.state !== 'ACTIVE' ||
            locked.idle_deadline_at.getTime() > Date.now()
          )
            return false;
          if (locked.execution_id) {
            const context = await executionContext(client, locked.execution_id);
            if (context.task_state === 'RUNNING')
              await stopExecution(
                client,
                context,
                'ERROR',
                'EXTERNAL_CONTROLLER_IDLE_TIMEOUT',
              );
          } else
            await this.coordinator.cancelInTransaction(locked.run_id, client);
          await client.query(
            "UPDATE pr_external_controllers SET state='EXPIRED',reason_code='EXTERNAL_CONTROLLER_IDLE_TIMEOUT',revision=revision+1 WHERE id=$1",
            [row.id],
          );
          return true;
        });
        // 扫描快照可能早于 touch；只有持锁后实际提交过期，才能撤销进程内执行。
        if (expired) {
          this.engine.abort(row.id, 'EXTERNAL_CONTROLLER_IDLE_TIMEOUT');
          continue;
        }
      }
      if (grant) {
        await this.coordinator
          .heartbeatExecution(grant.id, grant.leaseToken)
          .catch(() => this.engine.abort(row.id, 'EXECUTION_EXPIRED'));
        continue;
      }
      if (row.execution_id) continue;
      const claimed = await this.coordinator.claim(
        `external-${row.id}`,
        true,
        1,
        2,
        1,
        1,
        1,
        row.run_id,
      );
      if (claimed.execution)
        await this.engine.start(
          row.id,
          JSON.parse(JSON.stringify(claimed.execution)),
        );
    }
  }
  /** 停止扫描后等待共享引擎撤销，数据库此时必须仍可访问。 */
  async close() {
    this.closing = true;
    await this.engine.close();
  }
}
