import type { ExecutionGrant, VerificationReport } from '@proofrun/contracts';
import { validateRuntimeRequest } from '@proofrun/contracts';
import type { RuntimeDecisionFrame } from '@proofrun/execution-core/runtime';
import type {
  DecisionInput,
  DecisionModel,
} from '@proofrun/execution-core/model';
import { LeaseGuard } from '@proofrun/execution-driver/execution/lease';
import type { AgentConfig } from './config.js';
import type { ControlClient } from './client.js';
import { AgentFault, pause } from './http.js';

/** 轮询与模型并行，避免一个 tab 的慢模型阻止其他分组领取决定。 */
const DECISION_POLL_MS = 100;
/** 终态交付与撤权异步提交，短暂等待报告不会恢复动作权限或续租。 */
const TERMINAL_REPORT_MS = 5000;
/** 只接受安全领域错误，不能将供应商地址、正文或凭据写入 runtime。 */
const ERROR_CODE = /^[A-Z_]{1,80}$/;

/** 版本 1 worker 只调用模型与续租；浏览器、账本、步骤和最终报告均归服务端。 */
export async function executeRuntime(
  config: AgentConfig,
  client: ControlClient,
  model: DecisionModel,
  grant: ExecutionGrant,
  signal: AbortSignal,
): Promise<VerificationReport> {
  const stop = new AbortController();
  const guard = new LeaseGuard(
    client,
    grant,
    AbortSignal.any([signal, stop.signal]),
  );
  const active = new Set<Promise<void>>();
  // 有状态适配器按组保留实例；同组各轮与清理分别复用，不能每帧重置模型状态。
  const models = new Map<string, DecisionModel>();
  let after = 0;
  let failure: unknown;
  const decide = async (frame: RuntimeDecisionFrame) => {
    const send = (body: unknown) => {
      if (!validateRuntimeRequest(body) || body.type === 'start')
        throw new AgentFault(
          'INVALID_RUNTIME_REQUEST',
          '模型决定或审计格式无效',
        );
      return client.runtimeMutation(grant, frame.id, body);
    };
    try {
      const input: DecisionInput = {
        text: frame.text,
        context: JSON.parse(frame.text),
        ...(frame.modelDeadlineAt
          ? {
              modelDeadline:
                performance.now() +
                Math.max(0, Date.parse(frame.modelDeadlineAt) - Date.now()),
            }
          : {}),
        traceRequest: async (request) => {
          await send({
            type: 'trace_start',
            revision: frame.revision,
            request,
          });
          return async (result) =>
            send({ type: 'trace_finish', revision: frame.revision, result });
        },
      };
      if (frame.imageArtifact)
        input.image = await client.image(
          grant,
          frame.imageArtifact,
          guard.signal,
        );
      let outcome;
      try {
        const group =
          grant.task.profilePlan?.groups.find((group) =>
            group.stepIds.includes(input.context!.task.stepId!),
          )?.id ?? 'profile-cleanup';
        let selected = model;
        if (grant.task.profilePlan && model.fork) {
          if (!models.has(group)) models.set(group, model.fork());
          selected = models.get(group)!;
        }
        outcome = { output: await selected.decide(input, guard.signal) };
      } catch (error) {
        if (guard.signal.aborted) throw error;
        outcome = {
          error: {
            code:
              error instanceof AgentFault && ERROR_CODE.test(error.code)
                ? error.code
                : 'INVALID_MODEL_DECISION',
            status: error instanceof AgentFault ? error.status : 0,
            ...(error instanceof AgentFault
              ? {
                  message: error.message.slice(0, 4000) || '模型未交付有效决定',
                }
              : {}),
          },
        };
      }
      await send({ type: 'decision', revision: frame.revision, outcome });
    } catch (error) {
      // 旧帧已明确撤销，只能读取新上下文；不能把旧回复用于新代次。
      if (
        error instanceof AgentFault &&
        [
          'CONTROL_CHANGED',
          'EXECUTION_RUNTIME_LOST',
          'EXECUTION_EXPIRED',
        ].includes(error.code)
      )
        return;
      throw error;
    }
  };
  try {
    const {
      model: modelName,
      vision,
      commandMs,
      evidenceMs,
      maxTurns,
      maxContextChars,
    } = config;
    await client.runtimeStart(grant, {
      model: modelName,
      vision,
      commandMs,
      evidenceMs,
      maxTurns,
      maxContextChars,
    });
    while (!guard.signal.aborted) {
      if (failure) throw failure;
      const view = await client.runtimeView(grant, after, guard.signal);
      if (view.state !== 'ACTIVE') {
        if (view.state === 'FINISHED' && view.report) return view.report;
        throw new AgentFault(
          'EXECUTION_RUNTIME_LOST',
          '运行时已结束，未交付完整报告',
        );
      }
      for (const frame of view.decisions) {
        after = Math.max(after, frame.revision);
        const running = decide(frame)
          .catch((error) => {
            failure = error;
          })
          .finally(() => active.delete(running));
        active.add(running);
      }
      await pause(DECISION_POLL_MS, guard.signal);
    }
    throw guard.signal.reason;
  } catch (error) {
    // 报告提交会撤销续租；心跳可能比下一次 GET 先收到终态，仍应返回已经落库的报告。
    if (guard.signal.aborted) {
      const deadline = Date.now() + TERMINAL_REPORT_MS;
      while (Date.now() < deadline) {
        const view = await client
          .runtimeView(
            grant,
            after,
            AbortSignal.timeout(
              Math.max(1, Math.min(config.requestMs, deadline - Date.now())),
            ),
          )
          .catch(() => null);
        if (view?.state === 'FINISHED' && view.report) return view.report;
        if (!view || view.state !== 'ACTIVE') break;
        await pause(DECISION_POLL_MS);
      }
    }
    throw error;
  } finally {
    stop.abort(new AgentFault('EXECUTION_CLOSED', '模型 worker 执行结束'));
    await guard.close();
    await Promise.allSettled(active);
  }
}
