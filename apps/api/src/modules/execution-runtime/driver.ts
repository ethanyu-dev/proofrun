import type { ExecutionGrant, ModelCallWrite } from '@proofrun/contracts';
import type { ExecutionClient } from '@proofrun/execution-driver/execution/runner';
import type {
  ExecutionTiming,
  ExecutionView,
  CommandResult,
} from '@proofrun/execution-core/ports';
import { ExecutionFault } from '@proofrun/execution-core/faults';
import { pause } from '@proofrun/execution-driver/async';
import type { DecisionContextData } from '@proofrun/execution-core/execution/context';
import type { Database } from '../../db.js';
import { ApiError, canonical, digest } from '../../domain.js';
import type { Coordinator } from '../scheduling/coordinator.js';
import type { ExecutionControl } from '../scheduling/control.js';
import type { ModelCalls } from '../reports/model-calls.js';
import type { ArtifactStore } from '../reports/artifacts.js';

/** 轮询只读已入队命令；绝不因为无回执而生成另一个命令身份。 */
const RESULT_POLL_MS = 150;
/** 与原 Worker 及节点 PNG 交付保持同一字节上限。 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** JSON 时间投影与原 HTTP 客户端一致，不让 Date 对象跨领域端口改变行为。 */
function wire<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
/** 领域错误复用同一分类，网络/数据库诊断正文不进入执行报告。 */
async function mapped<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ExecutionFault) throw error;
    throw new ExecutionFault(
      error instanceof ApiError ? error.code : 'EXECUTION_RUNTIME_ERROR',
      error instanceof ApiError ? error.message : '运行时持久化或驱动失败',
      error instanceof ApiError ? error.statusCode : 0,
    );
  }
}

/** 服务端驱动端口复用原调度器、预算、报告验证及命令 outbox；不调用任何模型供应商。 */
export class RuntimeDriver {
  constructor(
    private readonly db: Database,
    private readonly coordinator: Coordinator,
    private readonly control: ExecutionControl,
    private readonly models: ModelCalls,
    private readonly artifacts: ArtifactStore,
    private readonly wrap?: (
      grant: ExecutionGrant,
      ports: ExecutionClient,
    ) => ExecutionClient,
  ) {}
  /** 终态仍可补交已开始模型调用的真实用量；不能由此派发新的模型或浏览器动作。 */
  async finishTrace(
    id: string,
    token: string,
    callId: string,
    result: Extract<ModelCallWrite, { phase: 'finish' }>['result'],
  ) {
    await this.models.write(id, callId, token, { phase: 'finish', result });
  }

  /** 每一步独立保存账本，模型请求快照与已接受进度分开；不复制证据原文。 */
  private async checkpoint(executionId: string, context: DecisionContextData) {
    const saved = await this.db.query(
      `UPDATE pr_execution_runtimes SET snapshot=jsonb_set(coalesce(snapshot,'{}'),ARRAY[$2],$3::jsonb,true),updated_at=clock_timestamp() WHERE execution_id=$1 AND state='ACTIVE'`,
      [executionId, context.task.stepId ?? 'browser', context],
    );
    if (!saved.rowCount)
      throw new ExecutionFault(
        'EXECUTION_RUNTIME_LOST',
        '运行时已结束，不能推进进度或动作',
      );
  }

  /** 闭包绑定原授权，分组不能改写运行身份。 */
  ports(grant: ExecutionGrant): ExecutionClient {
    const id = grant.id,
      token = grant.leaseToken;
    const ports: ExecutionClient = {
      view: () =>
        mapped(async () =>
          wire<ExecutionView>(await this.coordinator.execution(id, token)),
        ),
      // 租约唯一责任方仍是实际 worker；服务端守卫只观察，不替失联 worker 续期。
      heartbeat: () =>
        mapped(async () =>
          wire<ExecutionTiming & { leaseExpiresAt: string }>(
            await this.coordinator.execution(id, token),
          ),
        ),
      checkpoint: (context) => mapped(() => this.checkpoint(id, context)),
      recordSteps: (_grant, steps) =>
        mapped(async () =>
          wire<ExecutionTiming>(
            await this.coordinator.recordSteps(id, token, steps),
          ),
        ),
      recordModelCall: (_grant, callId, body) =>
        mapped(async () => {
          await this.models.write(id, callId, token, body);
        }),
      complete: (_grant, report, revision) =>
        mapped(async () => {
          await this.coordinator.complete(id, token, report, revision);
        }),
      intervene: (_grant, revision, reason, _signal, items, reasonCode, keys) =>
        mapped(async () => {
          await this.control.change(
            id,
            token,
            'request',
            revision,
            reason,
            items,
            reasonCode,
            undefined,
            keys,
          );
        }),
      acknowledge: (_grant, revision) =>
        mapped(async () => {
          await this.control.change(id, token, 'acknowledge', revision);
        }),
      command: (
        _grant,
        commandId,
        command,
        timeoutMs,
        signal,
        revision = 0,
        stepId,
      ) =>
        mapped(async () => {
          signal.throwIfAborted();
          const intent = {
            command,
            timeoutMs,
            controlRevision: revision,
            ...(stepId ? { stepId } : {}),
          };
          const hash = digest(canonical(intent));
          await this.db.query(
            `INSERT INTO pr_runtime_operations(command_id,execution_id,input_hash,intent,state) VALUES($1,$2,$3,$4,'PENDING') ON CONFLICT DO NOTHING`,
            [commandId, id, hash, intent],
          );
          const saved = (
            await this.db.query(
              'SELECT * FROM pr_runtime_operations WHERE command_id=$1',
              [commandId],
            )
          ).rows[0]!;
          if (saved.execution_id !== id || saved.input_hash !== hash)
            throw new ApiError(
              409,
              'IDEMPOTENCY_CONFLICT',
              '运行时命令身份冲突',
            );
          if (saved.result) return saved.result as CommandResult;
          if (saved.state === 'ABORTED')
            throw new ExecutionFault(
              'EXECUTION_RUNTIME_LOST',
              '运行时命令已终止',
            );
          let result: CommandResult | undefined;
          try {
            result = (
              await this.coordinator.command(
                id,
                token,
                commandId,
                timeoutMs,
                command,
                revision,
                stepId,
              )
            ).result as CommandResult | undefined;
            await this.db.query(
              "UPDATE pr_runtime_operations SET state='DISPATCHED' WHERE command_id=$1 AND state='PENDING'",
              [commandId],
            );
            const deadline = performance.now() + timeoutMs + 5000;
            while (!result) {
              if (performance.now() >= deadline)
                throw new ExecutionFault(
                  'COMMAND_RESULT_UNKNOWN',
                  '命令结果未能在预算内确认，不继续操作',
                );
              await pause(RESULT_POLL_MS, signal);
              result = (
                await this.coordinator.commandResult(id, token, commandId)
              ).result as CommandResult | undefined;
            }
          } catch (error) {
            // 撤权后只读已持久化回执，不能重发原命令。
            result = (
              await this.coordinator
                .commandResult(id, token, commandId)
                .catch(() => null)
            )?.result as CommandResult | undefined;
            if (!result) throw error;
          }
          await this.db.query(
            "UPDATE pr_runtime_operations SET state='FINISHED',result=$2 WHERE command_id=$1",
            [commandId, result],
          );
          return result;
        }),
      image: (_grant, ref, signal) =>
        mapped(async () => {
          signal.throwIfAborted();
          const file = await this.artifacts.read(ref.id, id);
          const chunks: Buffer[] = [];
          let size = 0;
          if (Buffer.isBuffer(file.body)) {
            chunks.push(file.body);
            size = file.body.length;
          } else
            try {
              for await (const chunk of file.body) {
                signal.throwIfAborted();
                const bytes = Buffer.from(chunk);
                size += bytes.length;
                if (size > MAX_IMAGE_BYTES)
                  throw new ExecutionFault('EVIDENCE_MISMATCH', '截图超过限额');
                chunks.push(bytes);
              }
            } finally {
              file.body.destroy();
            }
          const bytes = Buffer.concat(chunks);
          if (
            size > MAX_IMAGE_BYTES ||
            digest(bytes) !== ref.sha256 ||
            !bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          )
            throw new ExecutionFault(
              'EVIDENCE_MISMATCH',
              '截图内容与已登记证据不符',
            );
          return `data:image/png;base64,${bytes.toString('base64')}`;
        }),
    };
    return this.wrap ? this.wrap(grant, ports) : ports;
  }
}
