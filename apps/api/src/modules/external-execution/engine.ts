import type {
  AgentDecision,
  ExecutionGrant,
  VerificationReport,
  StepResult,
} from '@proofrun/contracts';
import type {
  DecisionInput,
  DecisionOutput,
} from '@proofrun/execution-core/model';
import { ExecutionFault } from '@proofrun/execution-core/faults';
import {
  execute,
  type ExecutionClient,
} from '@proofrun/execution-driver/execution/runner';
import type { Database } from '../../db.js';
import { ApiError } from '../../domain.js';
import { executionContext, stopExecution } from '../scheduling/state.js';
import type { BudgetState } from '../scheduling/step-budget.js';
import { RuntimeDriver } from '../execution-runtime/driver.js';
import { settleRuntimeOperations } from '../execution-runtime/supervisor.js';

/** 外部执行的策略来自平台，调用方不能扩大步骤预算或上下文上限。 */
const EXECUTION_CONFIG = {
  model: 'external-agent',
  vision: true,
  commandMs: 15000,
  evidenceMs: 60000,
  maxTurns: 200,
  maxContextChars: 64000,
};
/** 只发布稳定错误码，不把数据库或节点异常正文写入公共操作回执。 */
const SAFE_CODE = /^[A-Z_]{1,80}$/;
/** 决定用量读取准入账本；等待撤销/超时不能被误算成外部 Agent 提交。 */
function externalSteps<T extends StepResult[]>(
  source: T,
  budget: BudgetState | null,
): T {
  const steps = structuredClone(source);
  for (const step of steps) {
    const state =
      budget?.steps?.[step.stepId] ??
      (budget?.stepId === step.stepId ? budget : null);
    if (step.budgetUsage)
      Object.assign(step.budgetUsage, {
        decisionCalls: state?.modelCalls ?? step.budgetUsage.decisionCalls ?? 0,
        modelCalls: 0,
      });
  }
  return steps;
}
/** 外部等待只持有回调，不序列化闭包，也不从日志重放决定。 */
interface Waiting {
  /** 当前已冻结上下文，用于同进程唤醒；公开版本保存在数据库。 */
  input: DecisionInput;
  /** 仅接受已经持久登记的决定，错误则唤醒原纠错路径。 */
  resolve: (output: DecisionOutput) => void;
  reject: (error: unknown) => void;
}
/** 一个绑定只启动一个共享执行器，内部令牌仅存在内存。 */
interface Running {
  /** 内部租约与共享执行任务，绝不向外部 Agent 返回。 */
  grant: ExecutionGrant;
  /** 撤销信号和正在推进的宿主任务。 */
  stop: AbortController;
  running: Promise<void>;
  /** 单次等待帧，串行分组不会相互覆盖。 */
  pending?: Waiting;
  /** 上下文事务提交后才允许接收决定。 */
  ready?: boolean;
  /** 当前持久操作身份；后续自动观察关联同一决定。 */
  operationId?: string;
}
/** 外部 Agent 是共享驱动的决定端口，不另写一套浏览器循环或验收规则。 */
export class ExternalEngine {
  private readonly active = new Map<string, Running>();
  constructor(
    private readonly db: Database,
    private readonly driver: RuntimeDriver,
    private readonly publicUrl: string,
    private readonly idleMs = 300000,
  ) {}
  /** 内部续租凭据只提供给 supervisor，不通过公开视图投影。 */
  grant(id: string) {
    return this.active.get(id)?.grant;
  }
  /** 仅在上下文已提交且端口仍等待时允许新决定。 */
  waiting(id: string) {
    return this.active.get(id)?.ready === true;
  }

  /** 用量仅表示外部决定数，绝不伪造供应商调用或 token；平台内部计数仍用于冻结额度。 */
  private async report(
    id: string,
    source: VerificationReport,
  ): Promise<VerificationReport> {
    const report = structuredClone(source);
    const row = (
      await this.db.query(
        'SELECT c.decision_calls,e.budget_state FROM pr_external_controllers c LEFT JOIN pr_executions e ON e.id=c.execution_id WHERE c.id=$1',
        [id],
      )
    ).rows[0]!;
    report.executor = {
      kind: 'external',
      judgmentSource: 'external_agent',
      usageSource: 'unavailable',
      decisionCalls: row.decision_calls,
      modelCalls: null,
      promptTokens: null,
      completionTokens: null,
    };
    if (report.executionDetails)
      Object.assign(report.executionDetails, {
        model: 'external-agent',
        modelCalls: 0,
        promptTokens: 0,
        completionTokens: 0,
        modelUsage: [],
      });
    if (report.steps)
      report.steps = externalSteps(report.steps, row.budget_state);
    return report;
  }

  /** 原命令和回执决定效果，不能从 HTTP 202 或单纯缺错误推断动作成功。 */
  async settle(id: string) {
    const current = this.active.get(id);
    if (!current?.operationId) return;
    const operationId = current.operationId;
    const row = (
      await this.db.query(
        'SELECT * FROM pr_external_operations WHERE controller_id=$1 AND id=$2',
        [id, operationId],
      )
    ).rows[0];
    if (!row || row.state !== 'RUNNING') {
      delete current.operationId;
      return;
    }
    const commands = (
      await this.db.query(
        'SELECT kind,result FROM pr_commands WHERE id=ANY($1::text[])',
        [row.command_ids],
      )
    ).rows;
    const unknown = commands.some(
      (command) =>
        !command.result ||
        command.result.effect === 'MAY_HAVE_HAPPENED' ||
        command.result.operationStatus === 'UNKNOWN',
    );
    const failed = commands.find(
      (command) => command.result?.operationStatus === 'FAILED',
    );
    const error =
      row.error_code ??
      failed?.result.error?.code ??
      (failed ? 'COMMAND_FAILED' : null);
    await this.db.query(
      "UPDATE pr_external_operations SET state=$3,error_code=$4,result=$5 WHERE controller_id=$1 AND id=$2 AND state='RUNNING'",
      [
        id,
        operationId,
        unknown ? 'UNKNOWN' : error ? 'FAILED' : 'SUCCEEDED',
        error,
        {
          effect: unknown
            ? 'UNKNOWN'
            : commands.some(
                  (command) =>
                    command.result?.effect === 'COMPLETED' &&
                    command.kind === 'browser.act',
                )
              ? 'APPLIED'
              : commands.length
                ? 'OBSERVED'
                : 'NOT_STARTED',
        },
      ],
    );
    delete current.operationId;
  }

  /** 只有决定已事务提交后才可唤醒驱动；重复操作不会再次 resolve。 */
  accept(id: string, operationId: string, decision: AgentDecision) {
    const current = this.active.get(id);
    if (!current?.pending)
      throw new ApiError(410, 'EXECUTION_RUNTIME_LOST', '执行器已失效');
    current.operationId = operationId;
    const pending = current.pending;
    delete current.pending;
    current.ready = false;
    pending.resolve({ decision, promptTokens: 0, completionTokens: 0 });
  }
  /** 人工切换或认证变化撤销旧上下文；共享循环负责等待、重查和新的阶段门禁。 */
  refresh(id: string) {
    this.active
      .get(id)
      ?.pending?.reject(
        new ExecutionFault('CONTROL_CHANGED', '控制或认证版本已变化'),
      );
  }
  /** 所有取消都中止原进程栈，不创建替代执行。 */
  abort(id: string, code: string) {
    this.active
      .get(id)
      ?.stop.abort(new ExecutionFault(code, '外部控制已经结束'));
  }

  /** 启动前已冻结 external 和串行分组；所有浏览器端口继续调用原 RuntimeDriver。 */
  async start(id: string, grant: ExecutionGrant) {
    if (this.active.has(id)) return;
    await this.db.transaction(async (client) => {
      const context = await executionContext(client, grant.id);
      const controller = (
        await client.query(
          'SELECT state FROM pr_external_controllers WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (controller?.state !== 'ACTIVE' || context.task_state !== 'RUNNING')
        throw new ApiError(410, 'EXECUTION_ENDED', '绑定已关闭');
      await client.query(
        "INSERT INTO pr_execution_runtimes(execution_id,state,config) VALUES($1,'ACTIVE',$2)",
        [grant.id, EXECUTION_CONFIG],
      );
      await client.query(
        'UPDATE pr_external_controllers SET execution_id=$2 WHERE id=$1',
        [id, grant.id],
      );
    });
    const base = this.driver.ports(grant);
    const current: Running = {
      grant,
      stop: new AbortController(),
      running: Promise.resolve(),
    };
    this.active.set(id, current);
    const ports: ExecutionClient = {
      ...base,
      command: async (...args) => {
        if (current.operationId)
          await this.db.query(
            "UPDATE pr_external_operations SET command_ids=command_ids||to_jsonb($3::text) WHERE controller_id=$1 AND id=$2 AND state='RUNNING'",
            [id, current.operationId, args[1]],
          );
        return base.command(...args);
      },
      checkpoint: async (context) => {
        await base.checkpoint?.(context);
        // 已接受的进度即使后续动作失败也可见；此时尚未开放下一轮决定。
        await this.db.query(
          "UPDATE pr_external_controllers SET context=$2 WHERE id=$1 AND state='ACTIVE'",
          [id, context],
        );
        if (current.operationId)
          await this.db.query(
            "UPDATE pr_external_operations SET progress_applied=true WHERE controller_id=$1 AND id=$2 AND kind='decide' AND state='RUNNING' AND (result->>'hasProgress')::boolean",
            [id, current.operationId],
          );
      },
      decisionError: async (error) => {
        if (current.operationId)
          await this.db.query(
            'UPDATE pr_external_operations SET error_code=$3 WHERE controller_id=$1 AND id=$2',
            [
              id,
              current.operationId,
              error instanceof ExecutionFault && SAFE_CODE.test(error.code)
                ? error.code
                : 'EXECUTION_ERROR',
            ],
          );
      },
      recordSteps: async (g, steps) => {
        const stored = (
          await this.db.query<{
            step_results: StepResult[] | null;
            budget_state: BudgetState | null;
          }>(
            'SELECT t.step_results,e.budget_state FROM pr_tasks t JOIN pr_executions e ON e.task_id=t.id WHERE e.id=$1',
            [grant.id],
          )
        ).rows[0];
        const previous = current.operationId ? stored?.step_results : null;
        const facts = (values: StepResult[] | null | undefined) =>
          (values ?? []).map((step) => ({
            stepId: step.stepId,
            criteria: step.criteria,
            requirements: step.requirements,
            readings: step.readings,
          }));
        const changed =
          previous &&
          JSON.stringify(facts(previous)) !== JSON.stringify(facts(steps));
        const copy = externalSteps(steps, stored?.budget_state ?? null);
        const timing = await base.recordSteps(g, copy);
        // 验收结论可能先于后续要求校验保存；这类部分成功也必须在失败回执中可见。
        if (changed && current.operationId)
          await this.db.query(
            "UPDATE pr_external_operations SET progress_applied=true WHERE controller_id=$1 AND id=$2 AND state='RUNNING' AND (result->>'hasProgress')::boolean",
            [id, current.operationId],
          );
        return timing;
      },
      complete: async (g, report, revision) =>
        base.complete(g, await this.report(id, report), revision),
      recordModelCall: async () => {
        throw new ExecutionFault(
          'EXTERNAL_MODEL_FORBIDDEN',
          '外部执行不派发平台模型',
        );
      },
    };
    const decide = async (
      input: DecisionInput,
      signal: AbortSignal,
    ): Promise<DecisionOutput> => {
      signal.throwIfAborted();
      await this.settle(id);
      let resolve!: (value: DecisionOutput) => void,
        reject!: (error: unknown) => void;
      const result = new Promise<DecisionOutput>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void result.catch(() => {});
      const deadline = setTimeout(
        () =>
          reject(
            new ExecutionFault(
              'STEP_TIME_BUDGET_EXCEEDED',
              '外部决定等待超过步骤期限',
            ),
          ),
        Math.max(1, input.context!.budget.timeMs),
      );
      deadline.unref();
      current.ready = false;
      current.pending = { input, resolve, reject };
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      try {
        await this.db.transaction(async (client) => {
          const context = await executionContext(client, grant.id);
          if (context.control_mode !== 'AUTO')
            throw new ExecutionFault('CONTROL_CHANGED', '控制权已变化');
          const saved = await client.query(
            "UPDATE pr_external_controllers SET revision=revision+1,context=$2,control_revision=$3,auth_revision=$4,idle_deadline_at=clock_timestamp()+$5*interval '1 millisecond' WHERE id=$1 AND state='ACTIVE'",
            [
              id,
              input.context,
              context.control_revision,
              context.auth_revision,
              this.idleMs,
            ],
          );
          if (!saved.rowCount)
            throw new ExecutionFault('EXECUTION_EXPIRED', '外部控制已经结束');
        });
        signal.throwIfAborted();
        current.ready = true;
        return await result;
      } finally {
        clearTimeout(deadline);
        current.ready = false;
        signal.removeEventListener('abort', abort);
        delete current.pending;
      }
    };
    current.running = Promise.resolve()
      .then(() =>
        execute(
          { ...EXECUTION_CONFIG, apiUrl: this.publicUrl },
          ports,
          { decide },
          grant,
          current.stop.signal,
        ),
      )
      .then(async (report) => {
        const final = await this.report(id, report);
        await this.db.transaction(async (client) => {
          await client.query(
            "UPDATE pr_execution_runtimes SET state='FINISHED',result_report=$2 WHERE execution_id=$1",
            [grant.id, final],
          );
          await settleRuntimeOperations(client, grant.id);
          await client.query(
            "UPDATE pr_external_controllers SET state='CLOSED',revision=revision+1 WHERE id=$1 AND state='ACTIVE'",
            [id],
          );
        });
      })
      .catch(async () => {
        await this.db.transaction(async (client) => {
          const context = await executionContext(client, grant.id);
          if (context.task_state === 'RUNNING')
            await stopExecution(
              client,
              context,
              'ERROR',
              'EXECUTION_RUNTIME_LOST',
            );
          await client.query(
            "UPDATE pr_execution_runtimes SET state='LOST',error_code='EXECUTION_RUNTIME_LOST' WHERE execution_id=$1",
            [grant.id],
          );
          await client.query(
            "UPDATE pr_external_controllers SET state='LOST',reason_code='EXECUTION_RUNTIME_LOST',revision=revision+1 WHERE id=$1 AND state='ACTIVE'",
            [id],
          );
          await client.query(
            "UPDATE pr_external_operations SET error_code=coalesce(error_code,'EXECUTION_RUNTIME_LOST') WHERE controller_id=$1 AND state='RUNNING'",
            [id],
          );
          await settleRuntimeOperations(client, grant.id);
        });
      })
      .finally(async () => {
        await this.settle(id);
        this.active.delete(id);
      });
    void current.running.catch(() => {});
  }
  /** 关闭只撤销并等待，不借助内置 Agent 替外部完成业务清理。 */
  async close() {
    for (const id of this.active.keys())
      this.abort(id, 'EXECUTION_RUNTIME_LOST');
    await Promise.allSettled(
      [...this.active.values()].map((current) => current.running),
    );
  }
}
