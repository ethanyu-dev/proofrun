import { aggregateProfileReport } from '@proofrun/execution-core/report';
import { taskEvidenceKinds } from '@proofrun/contracts';
import { randomUUID } from 'node:crypto';
import { validateVerificationReport } from '@proofrun/contracts';
import type {
  ExecutionGrant,
  StepResult,
  VerificationReport,
} from '@proofrun/contracts';
import type { ExecutionConfig } from '@proofrun/execution-core/config';
import type { DecisionModel } from '@proofrun/execution-core/model';
import type {
  ExecutionClient,
  GroupExecutionClient,
  GroupExecutionScope,
} from './runner.js';
import type {
  ExecutionTiming,
  ExecutionView,
} from '@proofrun/execution-core/ports';
import { AgentFault, pause } from '../async.js';
import { LeaseGuard } from './lease.js';

/** 任一不确定写入或撤权终止整个 profile，不能让兄弟 tab 继续产生副作用。 */
const PROFILE_FATAL = new Set([
  'BROWSER_EFFECT_UNKNOWN',
  'LEASE_LOST',
  'EXECUTION_ENDED',
  'EXECUTION_EXPIRED',
  'COMMAND_RESULT_UNKNOWN',
]);
/** 人工期间保持轮询和续租，浏览器队列不持有长期锁。 */
const CONTROL_POLL_MS = 1000;

/** 异步互斥队列；失败只释放当前租约，不使后续任务继承 rejected Promise。 */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }
}

/** 一个领取对应一个 profile；组级执行器仅操作独占 tab，最终报告与关闭由此处统一负责。 */
export async function executeProfile(
  config: ExecutionConfig,
  client: ExecutionClient,
  model: DecisionModel,
  grant: ExecutionGrant,
  stop: AbortSignal,
  run: (
    config: ExecutionConfig,
    client: GroupExecutionClient,
    model: DecisionModel,
    grant: ExecutionGrant,
    stop: AbortSignal,
    scope: GroupExecutionScope,
  ) => Promise<VerificationReport>,
): Promise<VerificationReport> {
  const plan = grant.task.profilePlan!;
  const steps = grant.task.steps!;
  if (plan.environmentGateStepId && !grant.task.executionPlan)
    throw new AgentFault(
      'EXECUTION_PLAN_REQUIRED',
      '共享环境须在接收时冻结，请重新提交历史任务',
    );
  if (
    plan.environmentGateStepId &&
    (plan.environmentGateStepId !== plan.groups[0]?.stepIds[0] ||
      steps[0]?.stepId !== plan.environmentGateStepId ||
      steps[0]?.type !== 'setup')
  )
    throw new AgentFault(
      'INVALID_PROFILE_PLAN',
      '共享环境门禁必须绑定第一个分组的首个 setup',
    );
  const results = new Map<string, StepResult>(
    steps.map((step) => [
      step.stepId!,
      {
        stepId: step.stepId!,
        status: 'PENDING',
        summary: '尚未执行',
        criteria: [],
        evidenceRefs: [],
        startedAt: null,
        finishedAt: null,
        ...(plan.groups.find((g) => g.stepIds.includes(step.stepId!))
          ? {
              groupId: plan.groups.find((g) =>
                g.stepIds.includes(step.stepId!),
              )!.id,
            }
          : {}),
      },
    ]),
  );
  const reports: VerificationReport[] = [];
  const businessReports: VerificationReport[] = [];
  const browser = new SerialQueue();
  const snapshots = new SerialQueue();
  const abort = new AbortController();
  const signal = AbortSignal.any([stop, abort.signal]);
  const guard = new LeaseGuard(client, grant, signal);
  let modelIndex = 0;
  /** 首个共享环境门禁通过前兄弟组不进入 RUNNING，禁止并发中清登录。 */
  const gateId = plan.environmentGateStepId;
  let releaseEnvironment!: (ready: boolean) => void;
  const environmentReady = new Promise<boolean>((resolve) => {
    releaseEnvironment = resolve;
  });
  let sharedEnvironment:
    { mode: 'guest' | 'configured'; confirmedRevision?: number } | undefined =
    grant.task.executionPlan
      ? { mode: grant.task.executionPlan.environment.mode }
      : undefined;
  if (!gateId) releaseEnvironment(true);
  const allSteps = () =>
    steps.map((step) => structuredClone(results.get(step.stepId!)!));

  /** 各组只看自己的步骤预算；总动作数不能覆盖组内计数。 */
  const project = <T extends ExecutionTiming>(view: T, stepId?: string): T => {
    return {
      ...view,
      stepBudget: stepId ? (view.stepBudgets?.[stepId] ?? null) : null,
      actionCount: undefined,
    };
  };

  const executeGroup = async (id: string, ids: string[], cleanup = false) => {
    let active: string | undefined;
    const selected = new Set(ids);
    const timing = await client.view(grant, guard.signal);
    const localGrant: ExecutionGrant = {
      ...grant,
      leaseExpiresAt: timing.leaseExpiresAt,
      taskDeadlineAt: timing.taskDeadlineAt ?? grant.taskDeadlineAt,
      task: {
        ...structuredClone(grant.task),
        steps: steps.filter((step) =>
          selected.has(step.stepId!),
        ) as NonNullable<ExecutionGrant['task']['steps']>,
        acceptanceCriteria: grant.task.acceptanceCriteria.filter((c) =>
          selected.has(c.stepId!),
        ),
        cleanupStepIds: cleanup ? ids : [],
        target: { url: steps.find((step) => selected.has(step.stepId!))!.url },
      },
    };
    const scoped: GroupExecutionClient = {
      ...(client.checkpoint ? { checkpoint: client.checkpoint } : {}),
      profileEnvironment: () => sharedEnvironment,
      view: async (_grant, abortSignal) =>
        project(await client.view(grant, abortSignal), active) as ExecutionView,
      image: (_grant, artifact, abortSignal) =>
        client.image(grant, artifact, abortSignal),
      recordModelCall: async (_grant, callId, body) => {
        if (body.phase === 'start')
          body = {
            ...body,
            record: {
              ...body.record,
              callIndex: ++modelIndex,
              ...(active ? { stepId: active } : {}),
            },
          };
        await client.recordModelCall(grant, callId, body);
      },
      recordSteps: async (_grant, values) =>
        snapshots.run(async () => {
          active = values.find((s) => s.status === 'RUNNING')?.stepId ?? active;
          for (const value of values)
            results.set(value.stepId, {
              ...structuredClone(value),
              ...(!cleanup ? { groupId: id } : {}),
            });
          const timing = await client.recordSteps(grant, allSteps());
          const gate = gateId ? results.get(gateId) : undefined;
          const confirmation = gate?.preconditions?.find(
            (c) =>
              c.id === 'profile-guest' &&
              c.status === 'SATISFIED' &&
              c.source === 'human',
          );
          if (sharedEnvironment && confirmation?.controlRevision !== undefined)
            sharedEnvironment.confirmedRevision = confirmation.controlRevision;
          if (gate?.status === 'COMPLETED' && gate.phase === 'READY')
            releaseEnvironment(true);
          else if (
            gate &&
            ['BLOCKED', 'ERROR', 'SKIPPED'].includes(gate.status)
          )
            releaseEnvironment(false);
          return timing ? project(timing, active) : undefined;
        }),
      command: async (
        _grant,
        commandId,
        operation,
        timeout,
        abortSignal,
        revision,
      ) => {
        return browser.run(() =>
          client.command(
            grant,
            commandId,
            { ...operation, tabScope: id },
            timeout,
            abortSignal,
            revision,
            active,
          ),
        );
      },
      intervene: async (
        _grant,
        revision,
        reason,
        abortSignal,
        items,
        reasonCode,
        conditionKeys,
      ) =>
        browser.run(async () => {
          // 请求控制权前切到求助组；切页和暂停之间不允许其他组插入浏览器动作。
          await client.command(
            grant,
            randomUUID(),
            { type: 'browser.observe', screenshot: true, tabScope: id },
            config.commandMs,
            abortSignal,
            revision,
            active,
          );
          await client.intervene(
            grant,
            revision,
            `分组 ${id}：${reason}`.slice(0, 1000),
            abortSignal,
            items,
            reasonCode,
            conditionKeys,
          );
          // 请求获准立即暂停 profile 时钟，避免根守卫等到下次心跳才知道人工已接管。
          guard.syncTiming({
            controlMode: 'REQUESTED',
            controlRevision: revision + 1,
          });
        }),
      acknowledge: (_grant, revision, abortSignal) =>
        browser.run(() => client.acknowledge(grant, revision, abortSignal)),
    };
    const report = await run(
      config,
      scoped,
      model.fork?.() ?? model,
      localGrant,
      guard.signal,
      { lease: guard, timing: (view) => project(view, active) },
    );
    // 撤权时持久化可能被拒绝，最终内存汇总仍须保留子组真实终态与原始根因。
    for (const state of report.steps ?? [])
      results.set(state.stepId, {
        ...state,
        ...(!cleanup ? { groupId: id } : {}),
      });
    if (gateId && selected.has(gateId))
      releaseEnvironment(
        results.get(gateId)?.status === 'COMPLETED' &&
          results.get(gateId)?.phase === 'READY',
      );
    reports.push(report);
    if (!cleanup) businessReports.push(report);
    if (PROFILE_FATAL.has(report.executionDetails?.reasonCode ?? ''))
      abort.abort(
        new AgentFault(report.executionDetails!.reasonCode!, report.summary),
      );
    return report;
  };

  try {
    let next = 0;
    // TRACE 仍属于整个 profile；网络采集已按 tab 隔离，此次保持原有串行预算策略。
    const concurrency = taskEvidenceKinds(grant.task).some((k) =>
      ['NETWORK', 'TRACE', 'RUNTIME'].includes(k),
    )
      ? 1
      : plan.maxConcurrency;
    const workers = Array.from(
      { length: Math.min(concurrency, plan.groups.length) },
      async () => {
        try {
          while (next < plan.groups.length && !guard.signal.aborted) {
            const group = plan.groups[next++]!;
            if (
              gateId &&
              !group.stepIds.includes(gateId) &&
              !(await environmentReady)
            )
              continue;
            await executeGroup(group.id, group.stepIds);
          }
        } catch (error) {
          releaseEnvironment(false);
          abort.abort(error);
          throw error;
        }
      },
    );
    const settled = await Promise.allSettled(workers);
    const rejected = settled.find((result) => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    const cleanupIds = grant.task.cleanupStepIds ?? [];
    const ready =
      ![...results.values()].some((s) => s.phase === 'CHECKING') &&
      !reports.some(
        (r) => r.executionDetails?.reasonCode === 'ENVIRONMENT_NOT_READY',
      ) &&
      steps
        .filter((s) => s.type === 'setup' && !cleanupIds.includes(s.stepId!))
        .every(
          (s) =>
            results.get(s.stepId!)!.phase === 'READY' &&
            results.get(s.stepId!)!.status === 'COMPLETED',
        );
    if (cleanupIds.length && ready && !guard.signal.aborted)
      await executeGroup('profile-cleanup', cleanupIds, true);
    for (const state of results.values())
      if (state.status === 'PENDING') {
        state.status = 'SKIPPED';
        state.summary = '环境未就绪或 profile 已停止，本步骤未执行';
        state.reasonCode = 'ENVIRONMENT_NOT_READY';
        state.finishedAt = new Date().toISOString();
        state.criteria = [];
      }
    const failed =
      businessReports.find((r) => r.executionDisposition === 'ERROR') ??
      businessReports.find((r) => r.executionDisposition === 'BLOCKED') ??
      (guard.signal.aborted
        ? {
            executionDisposition: 'ERROR' as const,
            summary:
              guard.signal.reason instanceof Error
                ? guard.signal.reason.message
                : 'profile 已停止',
            executionDetails: {
              reasonCode:
                guard.signal.reason instanceof AgentFault
                  ? guard.signal.reason.code
                  : 'AGENT_STOPPED',
            },
          }
        : undefined);
    const report = aggregateProfileReport({
      task: grant.task,
      reports,
      failed,
      model: config.model,
      steps: allSteps() as NonNullable<VerificationReport['steps']>,
    });
    // 报告只在 profile 自动控制时交付，等待期间由根租约守卫续租。
    let view = await client.view(grant);
    while (
      view.taskState === 'RUNNING' &&
      view.controlMode &&
      view.controlMode !== 'AUTO' &&
      !guard.signal.aborted
    ) {
      if (view.controlMode === 'REQUESTED')
        await client.acknowledge(grant, view.controlRevision, guard.signal);
      await pause(CONTROL_POLL_MS, guard.signal);
      view = await client.view(grant);
    }
    await client.recordSteps(grant, report.steps!).catch(() => {});
    if (!validateVerificationReport(report))
      throw new AgentFault('INVALID_REPORT', 'profile 汇总报告不满足协议');
    await client.complete(grant, report, view.controlRevision);
    return report;
  } finally {
    await guard.close();
  }
}
