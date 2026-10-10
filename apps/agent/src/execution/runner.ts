import { stepLimit } from '@proofrun/contracts';
import { StepAllowance } from './step-budget.js';
import { stepObjective } from '../prompts/step.js';
import { randomUUID } from 'node:crypto';
import {
  validateAgentDecision,
  recoverableObservationFailure,
  validateVerificationReport,
  type AgentDecision,
  type ExecutionGrant,
  type VerificationReport,
  type VerificationTask,
  type StepResult,
} from '@proofrun/contracts';
import type { AgentConfig } from '../config.js';
import type { BrowserOperation, ControlClient } from '../client.js';
import type { DecisionInput, DecisionModel } from '../model/chat.js';
import { modelTraceFault } from '../model/request.js';
import { observation, type Observation } from '../evidence/observation.js';
import { waitForEvidence } from '../evidence/delivery.js';
import { AgentFault, pause, transient } from '../http.js';
import { LeaseGuard } from './lease.js';
import { Workflow } from './workflow.js';
import { needsLoginIntervention, requiresLogin } from './login-intervention.js';
import {
  decisionContext,
  rememberObservation,
  type RecentOperation,
  type PreviousObservation,
} from './context.js';
import {
  ObservationTracker,
  STALLED_ROUNDS,
  CYCLIC_VISITS,
  type ObservationChanges,
} from '../evidence/changes.js';

/** 连续格式错误或暂时模型故障至多修复三次，且计入总模型轮数。 */
const MAX_DECISION_ERRORS = 3;
/** 任务进度不足有独立恢复额度，不归类为模型格式错误。 */
const MAX_WORKFLOW_RECOVERIES = 3;
/** 证据上传与浏览器状态轮询不会占用新的模型调用。 */
const POLL_MS = 150;
/** 导航后只有外壳菜单时最多补采两次，不把无关导航交给模型猜测；不是业务就绪保证。 */
const SHELL_RETRIES = 2;
const SHELL_WAIT_MS = 300;
/** DOM 读取失败最多补采两次，只重试观察，仍受原任务期限及控制权约束。 */
const OBSERVATION_RETRIES = 2;
const OBSERVATION_RETRY_MS = 300;
/** 只将近期操作和证据摘要放入上下文，完整事实保留在控制面。 */
const HISTORY_LIMIT = 8;

/** 用显式端口测试编排规则，不将模型供应商或传输细节混入执行状态。 */
export type ExecutionClient = Pick<
  ControlClient,
  | 'view'
  | 'heartbeat'
  | 'command'
  | 'image'
  | 'complete'
  | 'intervene'
  | 'acknowledge'
  | 'recordModelCall'
  | 'recordSteps'
>;

/** 一个领取结果对应一个执行器；实例不复用，也不恢复已经失去租约的动作。 */
class Execution {
  /** 本地只保留当前观察和有界历史，完整命令与证据由控制面持久化。 */
  private readonly started = performance.now();
  private readonly guard: LeaseGuard;
  private readonly evidence = new Map<
    string,
    VerificationReport['artifacts'][number]
  >();
  /** 已执行操作的有界摘要，供上下文读取。 */
  private readonly history: RecentOperation[] = [];
  private readonly details: NonNullable<VerificationReport['executionDetails']>;
  /** 初始导航成功后不因人工切换重放，观察可单独作废。 */
  private navigated = false;
  /** 每次导航只执行一次有界外壳等待，不在普通决策轮反复等待。 */
  private settlePending = true;
  /** TRACE 由执行器按验收需求采集，模型不能指定路径或伪造文件身份。 */
  private traceStarted = false;
  private current: Observation | undefined;
  /** 比较原始观察，不因模型重规划或暂时遮挡重置。 */
  private readonly tracker = new ObservationTracker();
  private changes: ObservationChanges | undefined;
  /** 历史证据保留来源及裁剪标记，避免切换栏目后只剩无法解读的证据编号。 */
  private readonly previousObservations: PreviousObservation[] = [];
  private image: string | undefined;
  private feedback: string | null = null;
  /** 人工介入后旧模型回复与旧观察均失效。 */
  private controlRevision = 0;
  /** 决策轮次与模型调用次数分开，混合策略可以在同一轮派发多个供应商请求。 */
  private decisionIndex = 0;
  /** 每一步最多自动请求一次登录辅助，人工未解决问题时不能无限暂停。 */
  private readonly loginInterventions = new Set<number>();
  /** 原任务阶段和恢复计划由所有决策模式共享。 */
  private workflow: Workflow;
  /** 新版业务逐步独立计数，整段清理共享另一份额度；旧任务沿用冻结语义。 */
  private allowance: StepAllowance | undefined;
  /** 后续清理之间只切换 stepId，保留整段累计计数。 */
  private cleanupAllowance: StepAllowance | undefined;
  private stepIndex = 0;
  /** 逐步进度快照只由执行器推进，完成后不可再改写。 */
  private stepResults: StepResult[] = [];
  /** 当前步骤开始前的证据集合，防止旧观察被冒充为本步执行。 */
  private stepEvidence = new Set<string>();
  /** 当前完成决定明确引用的本步证据。 */
  private completionEvidence: string[] = [];
  /** 面向模型的局部定义，原始任务快照始终保持不变。 */
  private currentTask: VerificationTask | undefined;
  /** 最终交付与人工交接冲突时只重交报告，不重复执行已完成操作。 */
  private sequenceOutcome: VerificationReport | undefined;

  /** 当前步骤的模型视图不包含后续步骤和清理指令，避免模型抢跑。 */
  private get task(): VerificationTask {
    return this.currentTask ?? this.grant.task;
  }

  constructor(
    private readonly config: AgentConfig,
    private readonly client: ExecutionClient,
    private readonly model: DecisionModel,
    private readonly grant: ExecutionGrant,
    stop: AbortSignal,
  ) {
    this.guard = new LeaseGuard(client, grant, stop, (view) =>
      this.allowance?.sync(view),
    );
    this.workflow = new Workflow(grant.task.objective);
    this.stepResults = (grant.task.steps ?? []).map((step) => ({
      stepId: step.stepId!,
      status: 'PENDING',
      summary: '尚未执行',
      evidenceRefs: [],
      criteria: [],
      startedAt: null,
      finishedAt: null,
    }));
    this.details = {
      reasonCode: null,
      model: config.model,
      modelCalls: 0,
      actions: 0,
      elapsedMs: 0,
      commandIds: [],
      promptTokens: 0,
      completionTokens: 0,
      modelUsage: [],
    };
  }
  /** 异常报告不包含原始模型响应、认证信息或 fetch 的完整错误文本。 */
  private failure(error: unknown): VerificationReport {
    const fault =
      error instanceof AgentFault
        ? error
        : new AgentFault('AGENT_ERROR', '执行器发生异常，未得出业务验收结论');
    return this.report(
      fault.code.startsWith('STEP_') && fault.code.endsWith('_BUDGET_EXCEEDED')
        ? 'BLOCKED'
        : 'ERROR',
      fault.message,
      this.task.acceptanceCriteria.map((c) => ({
        criterionId: c.id,
        verdict: 'SKIPPED',
        summary: '执行未能完成验收',
        evidenceRefs: [],
      })),
      fault.code,
    );
  }
  /** 故障与阻塞没有产品判定，执行结果按逐项结论聚合。 */
  private report(
    disposition: VerificationReport['executionDisposition'],
    summary: string,
    criteria: VerificationReport['criteria'],
    code: string | null,
  ): VerificationReport {
    const verdict =
      disposition !== 'EXECUTED'
        ? null
        : criteria.some((c) => c.verdict === 'FAILED')
          ? 'FAILED'
          : criteria.every((c) => c.verdict === 'PASSED')
            ? 'PASSED'
            : 'INCONCLUSIVE';
    return {
      protocolVersion: '0.1',
      taskId: this.grant.task.taskId,
      lifecycle: 'COMPLETED',
      executionDisposition: disposition,
      verdict,
      summary,
      criteria,
      artifacts: [...this.evidence.values()],
      executionDetails: {
        ...this.details,
        commandIds: [...this.details.commandIds],
        reasonCode: code,
        elapsedMs: Math.round(performance.now() - this.started),
      },
    };
  }
  /** 定义或能力不足交还上层，未验收的标准仍逐项列出。 */
  private blocked(summary: string, code: string): VerificationReport {
    return this.report(
      'BLOCKED',
      summary,
      this.task.acceptanceCriteria.map((c) => ({
        criterionId: c.id,
        verdict: 'SKIPPED',
        summary,
        evidenceRefs: [],
      })),
      code,
    );
  }
  /** 所有动作都串行提交，命令身份只生成一次；未知效果直接结束。 */
  private async command(operation: BrowserOperation) {
    this.guard.signal.throwIfAborted();
    if (operation.type !== 'browser.trace') this.allowance?.assertTime();
    if (operation.type === 'browser.act') {
      this.allowance?.assert(
        'actions',
        this.details.actions,
        this.details.modelCalls,
      );
      if (
        !this.allowance &&
        this.details.actions >= this.grant.task.budget.maxActions
      )
        throw new AgentFault('ACTION_BUDGET_EXCEEDED', '浏览器动作预算已耗尽');
      this.details.actions++;
    }
    const id = randomUUID();
    this.details.commandIds.push(id);
    const result = await this.client
      .command(
        this.grant,
        id,
        operation,
        Math.max(
          1,
          Math.floor(Math.min(this.config.commandMs, this.guard.remaining())),
        ),
        this.guard.signal,
        this.controlRevision,
      )
      .catch((error: unknown) => {
        if (
          error instanceof AgentFault &&
          [
            'CONTROL_CHANGED',
            'STEP_ACTION_BUDGET_EXCEEDED',
            'STEP_TIME_BUDGET_EXCEEDED',
            'STEP_NOT_STARTED',
          ].includes(error.code) &&
          operation.type === 'browser.act'
        )
          this.details.actions--;
        throw error;
      });
    this.history.push({
      commandId: id,
      operation: operation.type,
      ...(operation.type === 'browser.act'
        ? {
            action: operation.action,
            targetName:
              this.current?.targets.find((t) => t.target === operation.target)
                ?.name ?? '',
            ...(operation.value === undefined
              ? {}
              : { value: operation.value }),
          }
        : {}),
      operationStatus: result.operationStatus,
      effect: result.effect,
    });
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    if (recoverableObservationFailure(operation.type, result))
      throw new AgentFault(
        'DOM_OBSERVATION_FAILED',
        '读取页面 DOM 失败（DOM_ENGINE_FAILED）',
      );
    if (
      result.effect === 'MAY_HAVE_HAPPENED' ||
      result.operationStatus === 'UNKNOWN'
    )
      throw new AgentFault(
        'BROWSER_EFFECT_UNKNOWN',
        '浏览器操作的效果不确定，未自动重放',
      );
    if (result.operationStatus !== 'SUCCEEDED')
      throw new AgentFault(
        result.effect === 'NOT_STARTED' &&
          result.error?.code === 'TARGET_OBSCURED'
          ? 'BROWSER_TARGET_OBSCURED'
          : result.effect === 'NOT_STARTED' &&
              result.error?.code === 'STALE_OBSERVATION'
            ? 'BROWSER_STALE_OBSERVATION'
            : 'BROWSER_COMMAND_FAILED',
        result.effect === 'NOT_STARTED' &&
          result.error?.code === 'TARGET_OBSCURED'
          ? '点击目标被遮挡，未派发点击。请基于新观察处理遮挡或调整滚动位置，不要直接重复同一个点击。'
          : `浏览器命令未成功（${result.operationStatus}），未判定业务失败`,
      );
    return result;
  }
  /** 动作与等待之后刷新事实；新观察不能与上一张截图混用。 */
  private async observe(
    screenshot = this.config.vision,
    countProgress = true,
  ): Promise<void> {
    const result = await this.readObservation(screenshot);
    this.allowance?.assertTime();
    const current = observation(result);
    if (!current.artifactRefs.some((ref) => ref.kind === 'DOM'))
      throw new AgentFault('EVIDENCE_UNAVAILABLE', '本次观察没有交付 DOM 引用');
    await waitForEvidence(
      current.artifactRefs,
      (signal) => this.client.view(this.grant, signal),
      Math.min(
        this.config.evidenceMs,
        this.allowance ? Math.max(1, this.allowance.remaining()) : Infinity,
      ),
      this.guard.signal,
    ).catch((error) => {
      this.allowance?.assertTime();
      throw error;
    });
    if (this.current)
      rememberObservation(this.previousObservations, this.current);
    this.changes = this.tracker.observe(current, countProgress);
    this.current = current;
    this.image = undefined;
    for (const ref of current.artifactRefs)
      this.evidence.set(ref.artifactId, {
        id: ref.artifactId,
        kind: ref.kind,
        sha256: ref.sha256,
        uri: `${this.config.apiUrl}/v1/artifacts/${encodeURIComponent(ref.artifactId)}`,
      });
    const png = current.artifactRefs.find((r) => r.kind === 'SCREENSHOT');
    if (screenshot && !png)
      throw new AgentFault('EVIDENCE_UNAVAILABLE', '本次观察没有返回所需截图');
    if (png)
      this.image = await this.client.image(
        this.grant,
        { id: png.artifactId, sha256: png.sha256 },
        this.guard.signal,
      );
  }
  /** 不重放已成功的动作；失败后清除旧观察，只有新证据采集成功才恢复模型决策。 */
  private async readObservation(screenshot: boolean) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.command({ type: 'browser.observe', screenshot });
      } catch (error) {
        if (
          !(error instanceof AgentFault) ||
          error.code !== 'DOM_OBSERVATION_FAILED'
        )
          throw error;
        this.current = undefined;
        this.image = undefined;
        this.changes = undefined;
        if (attempt >= OBSERVATION_RETRIES)
          throw new AgentFault(
            'DOM_OBSERVATION_FAILED',
            '读取页面 DOM 连续失败，已停止本步骤（DOM_ENGINE_FAILED）',
          );
        await pause(OBSERVATION_RETRY_MS, this.guard.signal);
        // 人工介入、取消或撤权优先于重试；交接后不恢复旧动作或旧观察身份。
        if (await this.checkpoint()) {
          this.workflow.invalidateRecovery();
          this.tracker.reset();
        }
      }
    }
  }
  /** 暂停等待不调用模型；时钟跟随控制面代次，恢复后必须重新观察页面。 */
  private async checkpoint(): Promise<boolean> {
    for (;;) {
      const view = await this.client.view(this.grant, this.guard.signal);
      if (view.taskState !== 'RUNNING')
        throw new AgentFault('EXECUTION_ENDED', '控制面已终止任务');
      this.guard.syncTiming(view);
      // 控制面是准入次数的权威；升级校准旧版人工计数后不能保留本地虚高值。
      if (view.actionCount !== undefined)
        this.details.actions = view.actionCount;
      if (!view.controlMode || view.controlMode === 'AUTO') {
        if (!view.stepBudget) this.allowance?.resume();
        const changed = this.controlRevision !== (view.controlRevision ?? 0);
        this.controlRevision = view.controlRevision ?? 0;
        return changed;
      }
      this.allowance?.pause();
      if (view.controlMode === 'REQUESTED')
        await this.client.acknowledge(
          this.grant,
          view.controlRevision,
          this.guard.signal,
        );
      await pause(POLL_MS, this.guard.signal);
    }
  }
  /** 在统一安全点取得预算快照；裁剪只影响发给模型的副本。 */
  private context(): DecisionInput {
    return decisionContext({
      task: this.task,
      executionStep: this.grant.task.steps?.[this.stepIndex],
      workflow: this.workflow.view(),
      budgetRemaining: this.allowance?.available(
        this.details.actions,
        this.details.modelCalls,
      ) ?? {
        actions: this.grant.task.budget.maxActions - this.details.actions,
        modelCalls: this.config.maxTurns - this.details.modelCalls,
        timeMs: Math.floor(this.guard.remaining()),
      },
      current: this.current!,
      changes: this.changes,
      evidence: [...this.evidence.values()],
      history: this.history,
      previousObservations: this.previousObservations,
      feedback: this.feedback,
      image: this.image,
      maxContextChars: this.config.maxContextChars,
    });
  }
  /** 停止真实浏览器 trace 后等待可靠交付，只有可用且归属匹配的引用才进入报告。 */
  private async captureTrace(): Promise<string[]> {
    if (this.traceStarted) {
      const result = await this.command({
        type: 'browser.trace',
        action: 'stop',
      });
      this.traceStarted = false;
      const refs = result.data?.artifactRefs as
        Array<{ artifactId: string; kind: string; sha256: string }> | undefined;
      const trace = refs?.find((ref) => ref.kind === 'TRACE');
      if (!trace)
        throw new AgentFault('EVIDENCE_UNAVAILABLE', '节点没有交付 TRACE');
      await waitForEvidence(
        [trace],
        (signal) => this.client.view(this.grant, signal),
        this.config.evidenceMs,
        this.guard.signal,
      );
      this.evidence.set(trace.artifactId, {
        id: trace.artifactId,
        kind: 'TRACE',
        sha256: trace.sha256,
        uri: `${this.config.apiUrl}/v1/artifacts/${encodeURIComponent(trace.artifactId)}`,
      });
    }
    return [...this.evidence.values()]
      .filter(
        (a) =>
          a.kind === 'TRACE' &&
          (!this.grant.task.steps || !this.stepEvidence.has(a.id)),
      )
      .map((a) => a.id);
  }
  /** 检查动作必需参数和观察身份；不向模型开放任意脚本或本地命令。 */
  private operation(
    decision: Extract<AgentDecision, { type: 'browser.act' }>,
  ): BrowserOperation {
    const invalid = () =>
      new AgentFault(
        'INVALID_MODEL_DECISION',
        '动作参数不完整或目标不属于当前观察',
      );
    if (['navigate', 'tab.new'].includes(decision.action)) {
      try {
        const url = new URL(decision.target ?? '');
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw invalid();
      } catch {
        throw invalid();
      }
    } else if (
      ['click', 'fill', 'hover', 'check', 'uncheck', 'select'].includes(
        decision.action,
      ) ||
      (decision.action === 'type' && decision.target !== undefined)
    ) {
      if (
        !this.current?.targets.some((t) => t.target === decision.target) ||
        (['fill', 'type', 'select'].includes(decision.action) &&
          decision.value === undefined)
      )
        throw invalid();
      return { ...decision, observationId: this.current.observationId };
    } else if (decision.action === 'scroll' && decision.target !== undefined) {
      const target = this.current?.targets.find(
        (t) => t.target === decision.target,
      );
      if (!target) throw invalid();
      if (target.operations && !target.operations.includes('scroll'))
        throw new AgentFault(
          'INVALID_MODEL_DECISION',
          `目标 ${decision.target}（${target.role}）不支持 scroll，可用操作：${target.operations.join('、')}。请滚动页面（不指定 target）或选择当前观察中的可滚动容器。`,
        );
      if (!['up', 'down', 'left', 'right'].includes(decision.value ?? ''))
        throw invalid();
      return { ...decision, observationId: this.current!.observationId };
    } else if (decision.action === 'visual.click') {
      if (
        !this.config.vision ||
        !this.image ||
        !Number.isFinite(decision.x) ||
        !Number.isFinite(decision.y)
      )
        throw invalid();
      return { ...decision, observationId: this.current!.observationId };
    } else if (decision.action === 'frame') {
      if (
        decision.target !== 'main' &&
        !this.current?.targets.some(
          (t) => t.target === decision.target && t.role === 'iframe',
        )
      )
        throw invalid();
      return { ...decision, observationId: this.current!.observationId };
    } else if (
      ['back', 'forward', 'reload', 'tab.switch', 'tab.close'].includes(
        decision.action,
      )
    ) {
      return decision;
    } else if (
      !decision.value ||
      (decision.action === 'scroll' &&
        !['up', 'down', 'left', 'right'].includes(decision.value))
    )
      throw invalid();
    return decision;
  }
  /** 完成决定只提供结论，证据元数据与总判定由执行器生成并由 API 再次核实。 */
  private finish(
    decision: Extract<AgentDecision, { type: 'verification.finish' }>,
  ): VerificationReport {
    const expected = this.task.acceptanceCriteria;
    const ids = new Set(decision.criteria.map((c) => c.criterionId));
    const invalid = () =>
      new AgentFault(
        'INVALID_MODEL_DECISION',
        '验收项必须完整且唯一，并引用已取得的所需类型证据',
      );
    if (
      decision.criteria.length !== expected.length ||
      ids.size !== expected.length
    )
      throw invalid();
    for (const criterion of expected) {
      const actual = decision.criteria.find(
        (c) => c.criterionId === criterion.id,
      );
      if (!actual || actual.evidenceRefs.some((id) => !this.evidence.has(id)))
        throw invalid();
      if (
        ['PASSED', 'FAILED'].includes(actual.verdict) &&
        criterion.evidenceKinds.some(
          (kind) =>
            !actual.evidenceRefs.some(
              (id) => this.evidence.get(id)?.kind === kind,
            ),
        )
      )
        throw invalid();
    }
    if (this.grant.task.steps) {
      const refs = [
        ...new Set([
          ...(decision.evidenceRefs ?? []),
          ...decision.criteria.flatMap((c) => c.evidenceRefs),
        ]),
      ];
      if (
        !refs.length ||
        refs.some((id) => !this.evidence.has(id) || this.stepEvidence.has(id))
      )
        throw invalid();
      this.completionEvidence = refs;
    }
    return this.report('EXECUTED', decision.summary, decision.criteria, null);
  }
  /** 先确认远端会话可达，再进入有界的观察与决策循环。 */
  private async loop(): Promise<VerificationReport> {
    this.guard.signal.throwIfAborted();
    if (
      !this.config.vision &&
      this.task.acceptanceCriteria.some((c) =>
        c.evidenceKinds.includes('SCREENSHOT'),
      )
    )
      return this.blocked(
        '任务要求截图验收，但当前 worker 未开启视觉模型支持',
        'VISION_REQUIRED',
      );
    for (;;) {
      const view = await this.client.view(this.grant, this.guard.signal);
      if (view.taskState !== 'RUNNING')
        throw new AgentFault('EXECUTION_ENDED', '任务在会话就绪前已终止');
      if (view.state === 'RUNNING') break;
      await pause(POLL_MS, this.guard.signal);
    }
    let errors = 0;
    let workflowRecoveries = 0;
    // 连续遮挡只允许有限次重新规划；仍消耗原动作与模型预算。
    let obscured = 0;
    while (this.allowance || this.details.modelCalls < this.config.maxTurns) {
      this.guard.signal.throwIfAborted();
      try {
        if (await this.checkpoint()) {
          this.current = undefined;
          this.workflow.invalidateRecovery();
          this.tracker.reset();
        }
        this.allowance?.assert(
          'modelCalls',
          this.details.actions,
          this.details.modelCalls,
        );
        if (
          !this.traceStarted &&
          this.task.acceptanceCriteria.some((c) =>
            c.evidenceKinds.includes('TRACE'),
          )
        ) {
          await this.command({ type: 'browser.trace', action: 'start' });
          this.traceStarted = true;
        }
        if (!this.navigated) {
          // 业务环境只从指定远端浏览器验证；worker 主机不需要访问业务内网。
          await this.command({
            type: 'browser.act',
            action: 'navigate',
            target: this.task.target.url,
          });
          this.navigated = true;
        }
        if (!this.current) await this.observe();
        if (this.settlePending) {
          this.settlePending = false;
          let retries = 0;
          while (
            retries < SHELL_RETRIES &&
            this.current!.targets.every(
              (t) =>
                ['menuitem', 'link', 'element'].includes(t.role) &&
                !(t.operations ?? []).some((op) =>
                  ['fill', 'select', 'scroll'].includes(op),
                ),
            )
          ) {
            await pause(SHELL_WAIT_MS, this.guard.signal);
            await this.observe(this.config.vision, false);
            retries++;
          }
          // 被动重采不累计动作循环，也不能清除导航前已经存在的循环记录。
        }
        // 登录前置条件需要人工时先交接，不能先进入模型重复观察或长时间等待挑战。
        if (
          !this.loginInterventions.has(this.stepIndex) &&
          needsLoginIntervention(this.grant.task, this.current!, this.stepIndex)
        ) {
          if (!this.grant.task.environment.allowIntervention)
            return this.blocked(
              '当前步骤需要登录，但任务未授权人工辅助',
              'INTERVENTION_DISABLED',
            );
          await this.requestIntervention(
            '当前步骤需要已登录账号，页面仍显示登录表单或人机验证，请完成本次登录',
            [
              // 独立处理页看不到完整定义，必须携带账号角色等原始约束，不能让处理者猜测。
              ...[
                this.grant.task.steps?.[this.stepIndex]?.description ??
                  this.grant.task.objective,
                ...(this.grant.task.steps?.[this.stepIndex]?.policy ?? []),
              ]
                .slice(0, 8)
                .map((item) => item.slice(0, 500)),
              '使用当前步骤指定的已授权账号完成登录；也可在本页写入该账号有效的 Cookie。',
              '按需完成人机验证，并确认账号身份符合当前步骤要求后继续任务。',
            ],
            true,
          );
          errors = 0;
          continue;
        }
        if ((this.changes?.unchangedRounds ?? 0) >= STALLED_ROUNDS)
          return this.blocked(
            '连续多轮操作和观察未获得新事实，停止重复执行；请检查页面覆盖或人工处理。',
            'NO_PROGRESS',
          );
        if (
          (this.changes?.repeatedStateVisits ?? 0) >= CYCLIC_VISITS &&
          this.changes?.unchangedRounds === 0
        )
          return this.blocked(
            '反复返回相同页面状态，且未记录新的阶段完成证据，停止循环。',
            'NO_PROGRESS',
          );
        const input = this.context();
        const decisionIndex = ++this.decisionIndex;
        input.traceRequest = async (request) => {
          traced = true;
          this.allowance?.assert(
            'modelCalls',
            this.details.actions,
            this.details.modelCalls,
          );
          if (
            !this.allowance &&
            this.details.modelCalls >= this.config.maxTurns
          )
            throw new AgentFault('MODEL_BUDGET_EXCEEDED', '模型请求预算已用完');
          const id = randomUUID();
          await this.client
            .recordModelCall(this.grant, id, {
              phase: 'start',
              record: {
                ...request,
                id,
                callIndex: this.details.modelCalls + 1,
                decisionIndex,
                startedAt: new Date().toISOString(),
                finishedAt: null,
                status: 'PENDING',
                response: null,
                error: null,
                promptTokens: null,
                completionTokens: null,
                elapsedMs: null,
                archived: false,
              },
            })
            .catch((error) => {
              throw modelTraceFault(error, 'start');
            });
          return async (result) => {
            await this.client
              .recordModelCall(this.grant, id, { phase: 'finish', result })
              .catch((error) => {
                throw modelTraceFault(error, 'finish');
              });
          };
        };
        let counted = false;
        let traced = false;
        // 混合调用即使后续格式校验失败，供应商已返回的用量也必须进入总计。
        let usageRecorded = false;
        input.recordRequest = (model) => {
          if (!traced)
            this.allowance?.assert(
              'modelCalls',
              this.details.actions,
              this.details.modelCalls,
            );
          if (
            !this.allowance &&
            this.details.modelCalls >= this.config.maxTurns
          )
            throw new AgentFault('MODEL_BUDGET_EXCEEDED', '模型请求预算已用完');
          this.details.modelCalls++;
          counted = true;
          let usage = this.details.modelUsage!.find(
            (entry) => entry.model === model,
          );
          if (!usage)
            this.details.modelUsage!.push(
              (usage = {
                model,
                calls: 0,
                promptTokens: 0,
                completionTokens: 0,
              }),
            );
          usage.calls++;
        };
        input.recordUsage = (model, promptTokens, completionTokens) => {
          usageRecorded = true;
          this.details.promptTokens += promptTokens;
          this.details.completionTokens += completionTokens;
          const usage = this.details.modelUsage!.find(
            (entry) => entry.model === model,
          );
          if (usage) {
            usage.promptTokens += promptTokens;
            usage.completionTokens += completionTokens;
          }
        };
        const output = await this.model
          .decide(input, this.guard.signal)
          .catch((error: unknown) => {
            if (transient(error))
              throw new AgentFault(
                'RETRYABLE_MODEL_ERROR',
                '模型服务暂时不可用',
              );
            throw error;
          })
          .finally(() => {
            if (!counted && !traced) this.details.modelCalls++;
          });
        this.guard.signal.throwIfAborted();
        if (!usageRecorded) {
          this.details.promptTokens += output.promptTokens;
          this.details.completionTokens += output.completionTokens;
        }
        // 模型调用期间可能收到暂停请求；旧决定只能丢弃，不能在人工恢复后执行。
        if (await this.checkpoint()) {
          this.workflow.invalidateRecovery();
          this.tracker.reset();
          await this.observe();
          continue;
        }
        this.allowance?.assertTime();
        const decision = output.decision;
        if (!validateAgentDecision(decision))
          throw new AgentFault('INVALID_MODEL_DECISION', '决定不满足工具协议');
        if (decision.type === 'browser.act') this.operation(decision);
        const revision = this.workflow.view().revision;
        this.workflow.apply(output.workflow, new Set(this.evidence.keys()));
        if (revision !== this.workflow.view().revision) {
          this.tracker.reset();
          workflowRecoveries = 0;
        }
        this.workflow.assertFinish(decision);
        this.workflow.assertAction(decision);
        if (decision.type === 'verification.intervene') {
          if (!this.grant.task.environment.allowIntervention)
            return this.blocked(decision.reason, 'INTERVENTION_DISABLED');
          await this.requestIntervention(
            decision.reason,
            decision.items,
            requiresLogin(this.grant.task, this.stepIndex),
          );
          errors = 0;
          continue;
        }
        if (decision.type === 'verification.finish') {
          const traces = await this.captureTrace();
          for (const criterion of decision.criteria) {
            if (
              this.task.acceptanceCriteria
                .find((c) => c.id === criterion.criterionId)
                ?.evidenceKinds.includes('TRACE')
            )
              criterion.evidenceRefs = [
                ...new Set([...criterion.evidenceRefs, ...traces]),
              ];
          }
          return this.finish(decision);
        }
        if (decision.type === 'verification.block')
          return this.blocked(decision.summary, 'MODEL_BLOCKED');
        let operation: BrowserOperation;
        if (decision.type === 'browser.act')
          operation = this.operation(decision);
        else if (decision.type === 'browser.observe') {
          if (decision.screenshot && !this.config.vision)
            throw new AgentFault(
              'INVALID_MODEL_DECISION',
              '当前模型配置不支持截图输入',
            );
          operation = decision;
        } else operation = decision;
        // 从这里开始发生浏览器操作；其传输错误绝不能进入模型重试分支。
        errors = 0;
        this.feedback = null;
        if (operation.type === 'browser.observe')
          await this.observe(
            this.config.vision || operation.screenshot === true,
          );
        else {
          await this.command(operation);
          if (operation.type === 'browser.act') {
            this.workflow.acted();
            workflowRecoveries = 0;
          }
          if (
            operation.type === 'browser.act' &&
            [
              'frame',
              'tab.switch',
              'tab.new',
              'navigate',
              'reload',
              'back',
              'forward',
            ].includes(operation.action)
          ) {
            this.tracker.reset(true);
            this.settlePending = true;
          }
          obscured = 0;
          await this.observe();
        }
      } catch (error) {
        if (
          error instanceof AgentFault &&
          ['WORKFLOW_INCOMPLETE', 'WORKFLOW_RECOVERY_EXHAUSTED'].includes(
            error.code,
          )
        ) {
          if (++workflowRecoveries >= MAX_WORKFLOW_RECOVERIES)
            return this.blocked(error.message, error.code);
          this.feedback = `${error.code}: ${error.message}`;
          continue;
        }
        if (
          error instanceof AgentFault &&
          ['BROWSER_TARGET_OBSCURED', 'BROWSER_STALE_OBSERVATION'].includes(
            error.code,
          )
        ) {
          if (++obscured >= MAX_DECISION_ERRORS)
            return this.blocked(error.message, error.code);
          this.current = undefined;
          this.image = undefined;
          this.feedback = `${error.code}: ${error.message}`;
          continue;
        }
        if (error instanceof AgentFault && error.code === 'CONTROL_CHANGED') {
          // 仅明确拒绝的旧代次可以重取观察；后续切换仍回到受保护的循环。
          this.current = undefined;
          this.image = undefined;
          continue;
        }
        // 除上面的确定未点击分支，其他浏览器故障仍直接生成故障报告。
        if (
          !(error instanceof AgentFault) ||
          !['INVALID_MODEL_DECISION', 'RETRYABLE_MODEL_ERROR'].includes(
            error.code,
          )
        )
          throw error;
        if (++errors >= MAX_DECISION_ERRORS) throw error;
        this.feedback = error.message;
        if (error.code === 'RETRYABLE_MODEL_ERROR')
          await pause(200 * errors, this.guard.signal);
      }
    }
    throw new AgentFault('MODEL_TURN_BUDGET_EXCEEDED', '模型决策轮数已耗尽');
  }
  /** 接管保留原租约和动作预算，执行时钟由控制面重置；登录恢复后重新访问目标使 Cookie 生效。 */
  private async requestIntervention(
    reason: string,
    items: string[] | undefined,
    login: boolean,
  ) {
    if (login) this.loginInterventions.add(this.stepIndex);
    await this.client.intervene(
      this.grant,
      this.controlRevision,
      reason,
      this.guard.signal,
      items,
    );
    // 请求成功即暂停本地时钟，不等待下一轮心跳；后台仍独立续租。
    this.guard.syncTiming({
      controlMode: 'REQUESTED',
      controlRevision: this.controlRevision + 1,
    });
    this.allowance?.pause();
    await this.checkpoint();
    this.workflow.invalidateRecovery();
    this.tracker.reset();
    this.feedback = null;
    if (login) {
      await this.command({
        type: 'browser.act',
        action: 'navigate',
        target: this.task.target.url,
      });
      this.settlePending = true;
    }
    await this.observe();
  }

  /** 显式等待由执行器计时，期间继续续租并检查取消，不反复调用模型或增加写动作。 */
  private async waitStep(durationMs: number) {
    if (durationMs >= this.guard.remaining())
      throw new AgentFault('WAIT_EXCEEDS_BUDGET', '剩余任务时间不足以完成等待');
    let remaining = durationMs;
    while (remaining > 0) {
      await this.checkpoint();
      this.allowance?.assertTime();
      const started = performance.now();
      await pause(Math.min(1000, remaining), this.guard.signal);
      remaining -= performance.now() - started;
    }
    await this.checkpoint();
    this.current = undefined;
    await this.observe();
  }

  /** 将终止原因和已完成结果合并；故障不能抹掉前面已持久化的验收事实。 */
  private sequenceReport(
    disposition: VerificationReport['executionDisposition'],
    summary: string,
    code: string | null,
  ): VerificationReport {
    for (const step of this.stepResults) {
      if (step.status === 'RUNNING') {
        step.status = disposition === 'BLOCKED' ? 'BLOCKED' : 'ERROR';
        step.summary = summary;
        step.finishedAt = new Date().toISOString();
      } else if (step.status === 'PENDING') {
        step.status = 'SKIPPED';
        step.summary = `执行已终止，未执行：${summary}`;
      }
    }
    const recorded = this.stepResults.flatMap((step) => step.criteria);
    const criteria = this.grant.task.acceptanceCriteria.map(
      (c) =>
        recorded.find((r) => r.criterionId === c.id) ?? {
          criterionId: c.id,
          verdict: 'SKIPPED' as const,
          summary: '该项尚未验收',
          evidenceRefs: [],
        },
    );
    const cleanupIds = new Set(this.grant.task.cleanupStepIds ?? []);
    const business = this.stepResults.filter(
      (step) => !cleanupIds.has(step.stepId),
    );
    const incomplete = business.filter((step) => step.status !== 'COMPLETED');
    const progress = `业务步骤执行完成 ${business.length - incomplete.length}/${business.length}；未完成：${incomplete.map((step) => `${step.stepId}（${step.status}）`).join('、') || '无'}。`;
    return {
      ...this.report(disposition, `${progress}\n${summary}`, criteria, code),
      steps: structuredClone(this.stepResults) as NonNullable<
        VerificationReport['steps']
      >,
    };
  }

  /** 逐步记录失败并继续后续业务，前置条件由各步核实；新版预算独立，撤权或未知操作效果立即停止。 */
  private async sequence(): Promise<VerificationReport> {
    const steps = this.grant.task.steps!;
    await this.checkpoint();
    if (this.sequenceOutcome) return this.sequenceOutcome;
    while (
      (await this.client.view(this.grant, this.guard.signal)).state !==
      'RUNNING'
    ) {
      await pause(POLL_MS, this.guard.signal);
      await this.checkpoint();
    }
    let stopped: VerificationReport | undefined;
    const cleanupIds = new Set(this.grant.task.cleanupStepIds ?? []);
    for (; this.stepIndex < steps.length; this.stepIndex++) {
      const step = steps[this.stepIndex]!;
      const state = this.stepResults[this.stepIndex]!;
      this.guard.signal.throwIfAborted();
      await this.checkpoint();
      this.currentTask = {
        ...this.grant.task,
        objective: stepObjective(
          this.grant.task,
          step,
          this.stepResults.slice(0, this.stepIndex),
        ),
        target: { url: step.url },
        acceptanceCriteria: this.grant.task.acceptanceCriteria.filter(
          (c) => c.stepId === step.stepId,
        ),
      };
      delete this.currentTask.caseV2Definition;
      delete this.currentTask.steps;
      delete this.currentTask.stepBudget;
      delete this.currentTask.cleanupStepIds;
      this.workflow = new Workflow(this.currentTask.objective, step.stepId);
      this.stepEvidence = new Set(this.evidence.keys());
      this.completionEvidence = [];
      this.navigated = false;
      this.current = undefined;
      this.image = undefined;
      this.feedback = null;
      this.settlePending = true;
      this.tracker.reset();
      this.changes = undefined;
      const limit = stepLimit(this.grant.task, step.stepId!);
      if (limit)
        this.currentTask.budget = {
          timeoutMs: limit.timeoutMs,
          maxActions: Math.max(1, limit.maxActions),
        };
      if (limit) {
        const cleanup = cleanupIds.has(step.stepId!);
        this.allowance =
          cleanup && this.cleanupAllowance
            ? this.cleanupAllowance
            : new StepAllowance(
                step.stepId!,
                limit,
                this.details.actions,
                this.details.modelCalls,
                cleanup,
              );
        this.allowance.stepId = step.stepId!;
        if (cleanup) this.cleanupAllowance = this.allowance;
      }
      const startUsage = this.allowance?.usage(
        this.details.actions,
        this.details.modelCalls,
      );
      state.status = 'RUNNING';
      state.startedAt = new Date().toISOString();
      state.summary = '执行中';
      const timing = await this.client.recordSteps(
        this.grant,
        this.stepResults,
      );
      if (timing) this.guard.syncTiming(timing);
      let report: VerificationReport;
      try {
        if (step.wait) {
          await this.waitStep(step.wait.durationMs);
          this.completionEvidence = [...this.evidence.keys()].filter(
            (id) => !this.stepEvidence.has(id),
          );
          report = step.expected.length
            ? await this.loop()
            : this.report(
                'EXECUTED',
                `已等待 ${step.wait.durationMs} 毫秒`,
                [],
                null,
              );
        } else report = await this.loop();
      } catch (error) {
        report = this.failure(error);
      }
      if (this.allowance && startUsage) {
        const usage = this.allowance.usage(
          this.details.actions,
          this.details.modelCalls,
        );
        state.budgetUsage = {
          ...usage,
          actions: usage.actions - startUsage.actions,
          modelCalls: usage.modelCalls - startUsage.modelCalls,
          elapsedMs: Math.max(0, usage.elapsedMs - startUsage.elapsedMs),
        };
        state.reasonCode = report.executionDetails?.reasonCode ?? null;
      }
      if (report.executionDisposition !== 'EXECUTED') {
        state.status =
          report.executionDisposition === 'BLOCKED' ? 'BLOCKED' : 'ERROR';
        state.summary = report.summary;
        state.finishedAt = new Date().toISOString();
        state.evidenceRefs = [...this.evidence.keys()].filter(
          (id) => !this.stepEvidence.has(id),
        );
        if (
          !cleanupIds.has(step.stepId!) &&
          (!stopped || report.executionDisposition === 'ERROR')
        )
          stopped = report;
        if (!this.guard.signal.aborted)
          await this.client.recordSteps(this.grant, this.stepResults);
        // 清理自身失败后不继续可能依赖它的清理，也不自动重放写入。
        if (
          cleanupIds.has(step.stepId!) ||
          this.guard.signal.aborted ||
          [
            'BROWSER_EFFECT_UNKNOWN',
            'LEASE_LOST',
            'EXECUTION_ENDED',
            'EXECUTION_EXPIRED',
          ].includes(report.executionDetails?.reasonCode ?? '')
        )
          break;
        continue;
      }
      state.status = 'COMPLETED';
      state.summary = report.summary;
      state.criteria = report.criteria;
      state.evidenceRefs = [...this.completionEvidence];
      state.finishedAt = new Date().toISOString();
      await this.client.recordSteps(this.grant, this.stepResults);
      if (
        step.type === 'setup' &&
        report.criteria.some((c) => c.verdict !== 'PASSED')
      ) {
        if (cleanupIds.has(step.stepId!)) {
          stopped ??= this.blocked(
            `清理步骤 ${step.stepId} 未通过验收，后续清理未执行`,
            'SETUP_NOT_PASSED',
          );
          break;
        }
      }
    }
    if (stopped)
      return this.sequenceReport(
        stopped.executionDisposition,
        stopped.summary,
        stopped.executionDetails?.reasonCode ?? null,
      );
    return this.sequenceReport(
      'EXECUTED',
      '已按 exec_order 顺序完成所有步骤，逐项结论见步骤及验收结果',
      null,
    );
  }

  /** 无论正常还是异常都提交一次不可变报告；提交失败交给调用者记录，租约负责最终回收。 */
  async run(): Promise<VerificationReport> {
    try {
      for (;;) {
        let report: VerificationReport;
        try {
          report = this.grant.task.steps
            ? await this.sequence()
            : await this.loop();
          if (this.grant.task.steps) this.sequenceOutcome = report;
        } catch (error) {
          const failure = this.failure(error);
          report = this.grant.task.steps
            ? this.sequenceReport(
                'ERROR',
                failure.summary,
                failure.executionDetails?.reasonCode ?? null,
              )
            : failure;
        }
        if (this.traceStarted && !this.guard.signal.aborted) {
          try {
            await this.captureTrace();
          } catch (error) {
            if (report.executionDisposition !== 'ERROR') {
              const failure = this.failure(error);
              report = this.grant.task.steps
                ? this.sequenceReport(
                    'ERROR',
                    failure.summary,
                    failure.executionDetails?.reasonCode ?? null,
                  )
                : failure;
            }
          }
          report.artifacts = [...this.evidence.values()];
          if (report.executionDetails) {
            report.executionDetails.commandIds = [...this.details.commandIds];
            report.executionDetails.elapsedMs = Math.round(
              performance.now() - this.started,
            );
          }
        }
        if (
          this.grant.task.steps &&
          report.steps &&
          !this.guard.signal.aborted
        ) {
          try {
            await this.client.recordSteps(this.grant, report.steps);
          } catch {
            /* 终态撤权时由最终报告提交保留已知事实。 */
          }
        }
        if (!validateVerificationReport(report))
          throw new AgentFault('INVALID_REPORT', '执行器生成的报告不满足协议');
        try {
          await this.client.complete(this.grant, report, this.controlRevision);
        } catch (error) {
          if (
            error instanceof AgentFault &&
            error.code === 'CONTROL_CHANGED' &&
            report.executionDisposition !== 'ERROR'
          ) {
            // 提交前被暂停时回到循环，等待中取消也必须生成故障报告。
            this.current = undefined;
            this.image = undefined;
            continue;
          }
          // 模型完成与取消可能同时发生；只有明确的终态拒绝才能改交故障报告。
          // 对不确定 HTTP 结果不改写报告，由客户端原样重送并由 API 去重。
          if (
            report.executionDisposition === 'ERROR' ||
            !(error instanceof AgentFault) ||
            !['EXECUTION_ENDED', 'EXECUTION_EXPIRED'].includes(error.code)
          )
            throw error;
          const failure = this.failure(error);
          report = this.grant.task.steps
            ? this.sequenceReport(
                'ERROR',
                failure.summary,
                failure.executionDetails?.reasonCode ?? null,
              )
            : failure;
          await this.client.complete(this.grant, report, this.controlRevision);
        }
        return report;
      }
    } finally {
      await this.guard.close();
    }
  }
}

/** 只执行已领取任务，不承担任务定义、全局调度或浏览器会话所有权。 */
export function execute(
  config: AgentConfig,
  client: ExecutionClient,
  model: DecisionModel,
  grant: ExecutionGrant,
  stop: AbortSignal = new AbortController().signal,
): Promise<VerificationReport> {
  return new Execution(config, client, model, grant, stop).run();
}
