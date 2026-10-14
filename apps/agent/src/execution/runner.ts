import { conditionKey, evaluatePolicyChecks } from './policy-checks.js';
import { InteractionProgress } from './interaction-progress.js';
import { executeProfile } from './profile-runner.js';
import {
  EnvironmentHandoffs,
  unresolvedRequirements,
  type EnvironmentCondition,
} from './environment-handoff.js';
import { CriteriaLedger } from './criteria.js';
import { evaluateChecks, mergeChecks } from './identity.js';
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
import {
  blockedLoginIntervention,
  needsLoginIntervention,
  requiresLogin,
} from './login-intervention.js';
import {
  decisionContext,
  rememberObservation,
  type RecentOperation,
  type PreviousObservation,
} from './context.js';
import {
  ObservationTracker,
  STALLED_ROUNDS,
  OBSERVATION_REVIEW_ROUNDS,
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
/** 访客人工复核的稳定定义，在交接前列出，不能在交还后追加要求。 */
const GUEST_CHECK = {
  id: 'profile-guest',
  method: 'manual' as const,
  description:
    '确认本 profile 已退出登录并清除登录状态，当前为未登录访客；团队或用户图标不能作为证明',
};

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
> & {
  /** 只由 profile 编排器共享意图与当前人工确认代次，不暴露认证数据。 */
  profileEnvironment?: () =>
    { mode: 'guest' | 'configured'; confirmedRevision?: number } | undefined;
  declareEnvironment?: (mode: 'guest' | 'configured') => void;
};

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
  /** 仅初次进入或步骤明确更换网址时安排导航；人工交还页面后取消待导航。 */
  private pendingNavigation: string | undefined;
  /** 自动登录最多执行一次，外部重入不会重置已提交登录。 */
  private identityPrepared = false;
  /** 节点只返回固定诊断，供 HITL 分类使用，不记录原始凭据。 */
  private preparationReason: string | undefined;
  /** 环境意图不等同身份事实；访客证明由隔离配置或当前人工确认提供。 */
  private environmentMode: 'guest' | 'configured' | undefined;
  /** 每次导航只执行一次有界外壳等待，不在普通决策轮反复等待。 */
  private settlePending = true;
  /** TRACE 由执行器按验收需求采集，模型不能指定路径或伪造文件身份。 */
  private traceStarted = false;
  private current: Observation | undefined;
  /** 比较原始观察，不因模型重规划或暂时遮挡重置。 */
  private readonly tracker = new ObservationTracker();
  private changes: ObservationChanges | undefined;
  /** 子项阅读与点击恢复独立于页面变化，按步骤和人工环境隔离。 */
  private interactions = new InteractionProgress();
  /** 历史证据保留来源及裁剪标记，避免切换栏目后只剩无法解读的证据编号。 */
  private readonly previousObservations: PreviousObservation[] = [];
  private image: string | undefined;
  private feedback: string | null = null;
  /** 人工介入后旧模型回复与旧观察均失效。 */
  private controlRevision = 0;
  /** 新计划的身份确认跟随认证环境；控制权变化仍拒绝旧动作。 */
  private authRevision = 0;
  private environmentProof: import('../client.js').ExecutionView['environmentProof'];
  private confirmationKeys = new Set<string>();
  /** 每步只给一次缺项修正反馈，后续仍受原预算和明确阻塞规则约束。 */
  private readonly incompleteFeedback = new Set<number>();
  /** 人工证明仅绑定当前控制代次；模型不能自行签发。 */
  private readonly confirmedChecks = new Map<string, number>();
  /** 每一步最多一次身份恢复，失败后继续后续独立步骤。 */
  private readonly identityInterventions = new Set<number>();
  /** 决策轮次与模型调用次数分开，混合策略可以在同一轮派发多个供应商请求。 */
  private decisionIndex = 0;
  /** 每一步最多自动请求一次登录辅助，人工未解决问题时不能无限暂停。 */
  private readonly loginInterventions = new Set<number>();
  /** 未解决条件分别交接，同一条件和整次执行均有上限。 */
  private readonly environmentHandoffs = new EnvironmentHandoffs();
  /** 人工交还前的准备证据只能作历史参考，不能再次证明环境已就绪。 */
  private readinessEvidence = new Set<string>();
  /** 原任务阶段和恢复计划由所有决策模式共享。 */
  private workflow: Workflow;
  /** 新版业务逐步独立计数，整段清理共享另一份额度；旧任务沿用冻结语义。 */
  private allowance: StepAllowance | undefined;
  /** 后续清理之间只切换 stepId，保留整段累计计数。 */
  private cleanupAllowance: StepAllowance | undefined;
  private stepIndex = 0;
  /** 上次本组 policy 通过时的共享控制代次；跨步骤也不能丢失重新检查要求。 */
  private readyRevision: number | undefined;
  /** 仅新版 profile 分组启用，准备 finish 只能进入独立检查阶段。 */
  private setupPhase: 'PREPARING' | 'CHECKING' | undefined;
  /** 兄弟 tab 人工改变共享环境后，暂存当前验证进度并重新检查本组 policy。 */
  private recheck: { task: VerificationTask; workflow: Workflow } | undefined;

  /** 复核只恢复本组验证进度，不重新执行已交付的验收项。 */
  private finishRecheck() {
    if (!this.recheck) return;
    this.currentTask = this.recheck.task;
    this.workflow = this.recheck.workflow;
    this.recheck = undefined;
    this.setupPhase = undefined;
    this.readyRevision = this.grant.task.executionPlan
      ? this.authRevision
      : this.controlRevision;
    this.stepResults[this.stepIndex]!.phase = 'VERIFYING';
    this.current = undefined;
    this.image = undefined;
    this.tracker.reset();
    this.feedback =
      '共享环境的 policy 已重新检查，可以继续本步骤未完成的验证。';
  }

  /** policy 检查只决定环境准入；准备阶段已采集的 expected 结论仍保留原证据。 */
  private finishProfileSetup(summary: string): VerificationReport {
    this.completionEvidence = [
      ...new Set([
        ...this.completionEvidence,
        ...this.criteria
          .values()
          .flatMap((criterion) => criterion.evidenceRefs),
      ]),
    ];
    return this.report('EXECUTED', summary, this.criteria.values(), null);
  }

  /** 逐步进度快照只由执行器推进，完成后不可再改写。 */
  private stepResults: StepResult[] = [];
  /** 当前步骤开始前的证据集合，防止旧观察被冒充为本步执行。 */
  private stepEvidence = new Set<string>();
  /** 当前完成决定明确引用的本步证据。 */
  private completionEvidence: string[] = [];
  /** 已校验的逐项结论独立于本步骤的执行状态。 */
  private criteria: CriteriaLedger;
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
    this.environmentMode = grant.task.executionPlan?.environment.mode;
    this.pendingNavigation =
      grant.task.steps?.[0]?.url ?? grant.task.target.url;
    this.guard = new LeaseGuard(client, grant, stop, (view) =>
      this.allowance?.sync(view),
    );
    this.workflow = new Workflow(grant.task.objective);
    this.criteria = new CriteriaLedger(grant.task.acceptanceCriteria);
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
      this.faultCriteria('执行未能完成验收'),
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
    return this.report('BLOCKED', summary, this.faultCriteria(summary), code);
  }
  /** 结构化步骤保留部分结论；旧任务沿用一次性交付语义。 */
  private faultCriteria(summary: string) {
    return (
      this.grant.task.steps
        ? this.criteria
        : new CriteriaLedger(this.task.acceptanceCriteria)
    ).complete(summary);
  }
  /** 所有动作都串行提交，命令身份只生成一次；未知效果直接结束。 */
  private async command(
    operation: BrowserOperation,
    timeoutMs = this.config.commandMs,
  ) {
    this.guard.signal.throwIfAborted();
    if (operation.type !== 'browser.trace') this.allowance?.assertTime();
    if (
      operation.type === 'browser.act' ||
      operation.type === 'browser.cookies.clear'
    ) {
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
    const clicked =
      operation.type === 'browser.act' && operation.action === 'click'
        ? this.current?.targets.find(
            (target) => target.target === operation.target,
          )
        : undefined;
    const id = randomUUID();
    this.details.commandIds.push(id);
    const result = await this.client
      .command(
        this.grant,
        id,
        operation,
        Math.max(1, Math.floor(Math.min(timeoutMs, this.guard.remaining()))),
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
            'COOKIE_CLEANUP_FORBIDDEN',
            'COOKIE_CLEANUP_UNSUPPORTED',
          ].includes(error.code) &&
          (operation.type === 'browser.act' ||
            operation.type === 'browser.cookies.clear')
        )
          this.details.actions--;
        throw error;
      });
    if (result.commandId && result.commandId !== id)
      this.details.commandIds[this.details.commandIds.length - 1] =
        result.commandId;
    this.history.push({
      commandId: result.commandId ?? id,
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
      ...(operation.type === 'browser.cookies.clear'
        ? {
            cookieCleanup: {
              names: operation.names,
              verified: result.data?.cleared === true,
            },
          }
        : {}),
      operationStatus: result.operationStatus,
      effect: result.effect,
    });
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    if (
      clicked &&
      this.current &&
      result.effect === 'NOT_STARTED' &&
      ['DOM_ACTION_PRECONDITION_FAILED', 'TARGET_OBSCURED'].includes(
        result.error?.code ?? '',
      )
    )
      this.interactions.failedClick(this.current, clicked, result.error?.code);
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
        `浏览器操作的效果不确定，未自动重放${result.error?.code === 'DOM_ENGINE_FAILED' ? '（DOM_ENGINE_FAILED）' : ''}`,
      );
    if (
      result.effect === 'NOT_STARTED' &&
      result.error?.code === 'DOM_ACTION_PRECONDITION_FAILED'
    )
      throw new AgentFault(
        'BROWSER_ACTION_PRECONDITION_FAILED',
        '目标输入尚未派发，DOM 定位或命中检查失败；请重新观察并选择与当前步骤相关的目标',
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
    if (
      operation.type === 'browser.cookies.clear' &&
      result.data?.cleared !== true
    )
      throw new AgentFault(
        'COOKIE_CLEANUP_UNVERIFIED',
        '节点未确认指定 Cookie 已清除，不能声称清理完成',
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
    this.interactions.observe(current);
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
    if (png && this.config.vision)
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
        const authChanged = this.authRevision !== (view.authRevision ?? 0);
        this.authRevision = view.authRevision ?? 0;
        this.environmentProof = view.environmentProof;
        this.confirmationKeys = new Set(
          view.humanConfirmation?.authRevision === this.authRevision
            ? (view.humanConfirmation.conditionKeys ?? [])
            : [],
        );
        const recheckNeeded =
          !this.recheck &&
          !!this.currentTask &&
          !this.isSetup() &&
          !this.isCleanup() &&
          this.readyRevision !== undefined &&
          this.readyRevision !==
            (this.grant.task.executionPlan
              ? this.authRevision
              : this.controlRevision);
        if (changed || recheckNeeded) {
          if (
            this.grant.task.profilePlan &&
            this.currentTask &&
            !this.isSetup() &&
            !this.isCleanup() &&
            recheckNeeded
          ) {
            const setup = this.grant.task.steps?.find(
              (step) => step.type === 'setup',
            );
            if (setup) {
              this.recheck = {
                task: this.currentTask,
                workflow: this.workflow,
              };
              this.currentTask = {
                ...this.currentTask,
                objective: `共享环境变化后重新核实本组 policy：${JSON.stringify(setup.policy)}`,
                acceptanceCriteria: [],
              };
              this.setupPhase = 'CHECKING';
              this.workflow = new Workflow(
                this.currentTask.objective,
                `${setup.stepId}-policy`,
                setup.policy,
              );
              this.stepResults[this.stepIndex]!.phase = 'CHECKING';
              await this.client.recordSteps(this.grant, this.stepResults);
            }
          }
          if (!this.grant.task.executionPlan || authChanged)
            this.invalidateReadiness();
          // 人工交还的是同一会话的当前页面；旧观察失效，但不能用导航覆盖处理结果。
          this.pendingNavigation = undefined;
          this.current = undefined;
          this.image = undefined;
          this.settlePending = false;
        }
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
      setupPhase: this.setupPhase,
      environmentReview: this.needsEnvironmentReview()
        ? {
            required: !this.environmentMode,
            requestedMode: this.grant.task.sessionPlan?.mode ?? 'manual',
            mode: this.environmentMode,
          }
        : undefined,
      executionStep: this.recheck
        ? this.grant.task.steps?.find((step) => step.type === 'setup')
        : this.grant.task.steps?.[this.stepIndex],
      recordedCriteria: this.recheck ? [] : this.criteria.values(),
      cleanup: this.isCleanup(),
      policyChecks: this.policyResults(),
      preconditions: [
        ...this.platformChecks(),
        ...evaluateChecks(
          this.identityChecks(),
          this.current!,
          this.confirmedChecks,
          this.controlRevision,
          this.grant.task.executionPlan ? this.authRevision : undefined,
        ),
      ],
      workflow: this.workflow.view(),
      interactionProgress: this.interactions.view(),
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
      evidence: [...this.currentEvidence().values()],
      history: this.history,
      previousObservations: this.previousObservations,
      feedback: this.feedback,
      image: this.image,
      maxContextChars: this.config.maxContextChars,
    });
  }
  /** 模型可引用列表与提交校验共用同一边界，前序步骤及准备阶段证据仅作历史背景。 */
  private currentEvidence() {
    return this.grant.task.steps
      ? new Map(
          [...this.evidence].filter(
            ([id]) =>
              !this.stepEvidence.has(id) &&
              (!this.isSetup() || !this.readinessEvidence.has(id)),
          ),
        )
      : this.evidence;
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
      if (!target.operations?.includes('scroll'))
        throw new AgentFault(
          'INVALID_MODEL_DECISION',
          `目标 ${decision.target}（${target.role}）不支持 scroll，可用操作：${target.operations?.join('、') ?? '未知'}。请滚动页面（不指定 target）或选择当前观察中的可滚动容器。`,
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
    ledger = this.criteria,
  ): VerificationReport {
    const invalid = () => ledger.invalid('完成结果缺少本步骤新取得的执行证据');
    const pending = ledger.pending();
    if (pending.length) throw ledger.invalid(`尚未登记：${pending.join('、')}`);
    if (this.grant.task.steps) {
      const refs = [
        ...new Set([
          ...(decision.evidenceRefs ?? []),
          ...ledger.values().flatMap((c) => c.evidenceRefs),
        ]),
      ];
      if (
        !refs.length ||
        refs.some(
          (id) =>
            !this.evidence.has(id) ||
            this.stepEvidence.has(id) ||
            (this.isSetup() && this.readinessEvidence.has(id)),
        )
      )
        throw invalid();
      this.completionEvidence = refs;
    }
    return this.report(
      'EXECUTED',
      decision.summary,
      ledger.complete('该项尚未验收'),
      null,
    );
  }
  /** 清理权限由不可变任务定义决定，模型不能自行切换阶段。 */
  private isCleanup(): boolean {
    return (
      this.grant.task.cleanupStepIds?.includes(
        this.grant.task.steps?.[this.stepIndex]?.stepId ?? '',
      ) === true
    );
  }
  /** cleanup 不承担环境准备职责，但仍受此前 setup 门禁约束。 */
  private isSetup(): boolean {
    if (this.recheck) return true;
    return (
      this.grant.task.steps?.[this.stepIndex]?.type === 'setup' &&
      !this.isCleanup()
    );
  }

  /** 首个 setup 在兄弟组启动之前分类共享登录要求，避免并发中途变更认证。 */
  private needsEnvironmentReview() {
    return (
      this.grant.task.profilePlan?.environmentGateStepId !== undefined &&
      this.grant.task.profilePlan.environmentGateStepId ===
        this.grant.task.steps?.[this.stepIndex]?.stepId &&
      !this.isCleanup()
    );
  }

  /** 复核使用原 setup 定义；业务及清理检查始终读取各自冻结条件。 */
  private policyResults() {
    const step = this.recheck
      ? this.grant.task.steps?.find((item) => item.type === 'setup')
      : this.grant.task.steps?.[this.stepIndex];
    return this.current && step && this.grant.task.executionPlan
      ? evaluatePolicyChecks(step, this.current)
      : [];
  }

  /** 结构化证据不能被模型完成声明或人工勾选覆盖；原始自由 policy 仍由模型评估。 */
  private syncPolicyChecks() {
    const results = this.policyResults();
    if (!results.length) return;
    const state = this.stepResults[this.stepIndex]!;
    const ids = new Set(results.map((result) => result.id));
    state.preconditions = [
      ...(state.preconditions ?? []).filter((item) => !ids.has(item.id)),
      ...results.map(({ policyIndex: _index, reason, ...result }) => ({
        ...result,
        description: `${result.description}（${reason}）`,
      })),
    ];
    if (this.setupPhase !== 'CHECKING') return;
    const steps = this.workflow.view().steps;
    const assessments = [
      ...new Set(results.map((result) => result.policyIndex)),
    ].map((index) => {
      const group = results.filter((result) => result.policyIndex === index);
      return {
        stepId: steps[index]!.id,
        outcome: group.every((result) => result.status === 'SATISFIED')
          ? 'complete'
          : 'incomplete',
        summary: group
          .map((result) => `${result.description}: ${result.reason}`)
          .join('；')
          .slice(0, 600),
        evidenceRefs: [
          ...new Set(group.flatMap((result) => result.evidenceRefs)),
        ].slice(0, 24),
      };
    });
    this.workflow.apply({ assessments }, new Set(this.evidence.keys()));
  }

  /** 缺失与明确失败均不能跳过固定条件；先反馈补证据，耗尽后由报告表达原因。 */
  private assertPolicyChecks() {
    this.syncPolicyChecks();
    const missing = this.policyResults().filter(
      (result) => result.status !== 'SATISFIED',
    );
    if (missing.length)
      throw new AgentFault(
        'POLICY_EVIDENCE_INCOMPLETE',
        missing
          .map((result) => `${result.description}: ${result.reason}`)
          .join('；'),
      );
  }

  /** 汇总当前缺失事实，显式前置条件不被模型的自由描述覆盖。 */
  private environmentConditions(): EnvironmentCondition[] {
    const checks = this.current
      ? evaluateChecks(
          this.identityChecks(),
          this.current,
          this.confirmedChecks,
          this.controlRevision,
          this.grant.task.executionPlan ? this.authRevision : undefined,
        )
      : [];
    return [
      ...checks
        .filter((check) => check.status !== 'SATISFIED')
        .map((check) => ({
          id: `check:${check.id}`,
          description: check.description,
          summary:
            check.status === 'UNSATISFIED'
              ? '当前观察不满足指定条件'
              : '该条件尚未确认',
          status: check.status as 'UNSATISFIED' | 'UNCONFIRMED',
        })),
      ...unresolvedRequirements(this.workflow.view()).map((condition) => ({
        ...condition,
        id: this.setupPhase
          ? `${this.setupPhase}:${condition.id}`
          : condition.id,
      })),
    ];
  }

  /** 只有环境问题进入交接；不同条件可继续处理，同一条件不重复等待。 */
  private async environmentNotReady(
    summary: string,
    conditions = this.environmentConditions(),
  ): Promise<VerificationReport | null> {
    const policyMissing = this.policyResults().filter(
      (result) => result.status !== 'SATISFIED',
    );
    if (
      this.grant.task.executionPlan &&
      !conditions.some(
        (condition) =>
          condition.id.startsWith('check:') || condition.id === 'session:login',
      ) &&
      policyMissing.some((result) => result.status === 'UNCONFIRMED')
    ) {
      this.assertPolicyChecks();
    }
    const unresolved = conditions.length
      ? conditions
      : [
          {
            id: 'environment:unconfirmed',
            description: '确认当前步骤的验证环境',
            summary,
            status: 'UNCONFIRMED' as const,
          },
        ];
    const detail = unresolved
      .map((condition) => `${condition.description}：${condition.summary}`)
      .join('；');
    const stateHistory = this.stepResults[this.stepIndex]!;
    if (this.grant.task.executionPlan) {
      stateHistory.environmentHistory = [
        ...(stateHistory.environmentHistory ?? []),
        {
          reason: summary,
          conditions: unresolved,
          controlRevision: this.controlRevision,
          authRevision: this.authRevision,
          recordedAt: new Date().toISOString(),
        },
      ].slice(-16) as NonNullable<StepResult['environmentHistory']>;
      await this.client.recordSteps(this.grant, this.stepResults);
    }
    const confirmationVersion = this.grant.task.executionPlan
      ? this.authRevision
      : 0;
    let requested = this.grant.task.environment.allowIntervention
      ? this.environmentHandoffs.claim(
          this.grant.task.steps![this.stepIndex]!.stepId!,
          unresolved,
          confirmationVersion,
        )
      : [];
    if (requested.length) {
      // 本轮人工输入可能使身份失效，因此把所有适用的人工身份条件明确列入待办。
      const manual = this.grant.task.executionPlan
        ? this.identityChecks(true)
            .filter((check) => check.method === 'manual')
            .map((check) => ({
              id: `check:${check.id}`,
              description: check.description,
              summary: '请在本轮操作完成后重新确认',
              status: 'UNCONFIRMED' as const,
            }))
        : [];
      if (manual.length) {
        const extra = requested.filter(
          (item) => !manual.some((check) => check.id === item.id),
        );
        const omitted = extra.slice(Math.max(0, 10 - manual.length));
        if (omitted.length)
          this.environmentHandoffs.release(
            this.grant.task.steps![this.stepIndex]!.stepId!,
            omitted,
            confirmationVersion,
            false,
          );
        requested = [
          ...manual,
          ...extra.slice(0, Math.max(0, 10 - manual.length)),
        ];
      }
      const keys = this.grant.task.executionPlan
        ? requested.map((item) => {
            const check = this.identityChecks(true).find(
              (check) => item.id === `check:${check.id}`,
            );
            return check
              ? conditionKey('identity', check)
              : conditionKey(this.grant.task.steps![this.stepIndex]!.stepId!, {
                  id: item.id,
                  description: item.description,
                });
          })
        : undefined;
      const revision = this.controlRevision;
      try {
        await this.requestIntervention(
          `不符合验证环境：${summary}。待处理：${requested.map((item) => `${item.description}：${item.summary}`).join('；')}`.slice(
            0,
            1000,
          ),
          requested.map((condition) =>
            `${condition.description}：${condition.summary}`.slice(0, 500),
          ),
          requested.some((condition) => condition.id === 'session:login'),
          keys,
        );
      } catch (error) {
        if (error instanceof AgentFault && error.code === 'CONTROL_CHANGED')
          this.environmentHandoffs.release(
            this.grant.task.steps![this.stepIndex]!.stepId!,
            requested,
            confirmationVersion,
          );
        throw error;
      }
      const returned = this.grant.task.profilePlan
        ? await this.client.view(this.grant, this.guard.signal)
        : undefined;
      const explicitlyConfirmed = (id: string) =>
        requested.some(
          (item) =>
            item.id === id &&
            returned?.humanConfirmation?.revision === this.controlRevision &&
            (keys
              ? returned.humanConfirmation.conditionKeys?.includes(
                  keys[requested.indexOf(item)]!,
                )
              : returned.humanConfirmation.items.includes(
                  `${item.description}：${item.summary}`.slice(0, 500),
                )),
        );
      // 新版只接受处理页逐项提交的确认；管理员恢复控制权不能冒充确认账号条件。
      if (this.controlRevision > revision)
        for (const check of this.identityChecks())
          if (
            check.method === 'manual' &&
            requested.some((item) => item.id === `check:${check.id}`) &&
            (!this.grant.task.profilePlan ||
              explicitlyConfirmed(`check:${check.id}`))
          )
            this.confirmedChecks.set(
              check.id,
              this.grant.task.executionPlan
                ? this.authRevision
                : this.controlRevision,
            );
      if (this.setupPhase === 'CHECKING') {
        const view = await this.client.view(this.grant, this.guard.signal);
        if (view.humanConfirmation?.revision === this.controlRevision) {
          const confirmed = requested.filter(
            (condition) =>
              view.humanConfirmation!.items.includes(
                `${condition.description}：${condition.summary}`.slice(0, 500),
              ) ||
              (!!keys &&
                view.humanConfirmation!.conditionKeys?.includes(
                  keys[requested.indexOf(condition)]!,
                )),
          );
          const assessments = this.workflow
            .view()
            .steps.filter((step) =>
              confirmed.some(
                (condition) =>
                  condition.id === `CHECKING:requirement:${step.id}`,
              ),
            )
            .map((step) => ({
              stepId: step.id,
              outcome: 'complete',
              summary:
                '人工在本次交接中逐项确认该 policy；页面证据仅记录交还现场',
              evidenceRefs: this.current!.artifactRefs.map((r) => r.artifactId),
            }));
          if (assessments.length)
            this.workflow.apply({ assessments }, new Set(this.evidence.keys()));
        }
      }
      this.feedback =
        '人工已交还控制权。请重新核实完整准备要求：已解决项提交新证据，其余未解决项明确说明原因；不得沿用旧账号证据或仅凭人工完成判定就绪。';
      return null;
    }
    const state = this.stepResults[this.stepIndex]!;
    state.blockage = {
      conditions: unresolved,
      evidenceRefs: [],
      recordedAt: new Date().toISOString(),
    };
    return this.blocked(
      `不符合验证环境：${summary}。未解决条件：${detail}`,
      'ENVIRONMENT_NOT_READY',
    );
  }

  /** 登录有独立条件身份，登录恢复后不消耗角色、绑定或页面准备条件的交接机会。 */
  private loginCondition(summary: string): EnvironmentCondition[] {
    const step = this.grant.task.steps?.[this.stepIndex];
    return [
      {
        id: 'session:login',
        description: '使用当前步骤指定的已授权账号完成登录',
        summary: `${summary}。原始账号要求：${step?.description ?? this.task.objective}；${step?.policy.join('；') ?? ''}`,
        status: 'UNCONFIRMED',
      },
    ];
  }

  /** 在终止步骤处冻结观察；截图失败只记录取证限制，不能覆盖业务阻塞原因。 */
  private async preserveBlockage(allowCapture: boolean) {
    const state = this.stepResults[this.stepIndex]!;
    const conditions =
      state.blockage?.conditions ??
      (this.isSetup() ? this.environmentConditions() : []);
    let screenshotError: string | undefined;
    if (
      allowCapture &&
      !this.current?.artifactRefs.some((ref) => ref.kind === 'SCREENSHOT') &&
      !this.guard.signal.aborted
    ) {
      try {
        await this.observe(true, false);
      } catch (error) {
        screenshotError =
          error instanceof AgentFault ? error.code : 'SCREENSHOT_UNAVAILABLE';
      }
    }
    const refs =
      this.current?.artifactRefs
        .map((ref) => ref.artifactId)
        .filter((id) => this.evidence.has(id) && !this.stepEvidence.has(id)) ??
      [];
    const hasScreenshot = refs.some(
      (id) => this.evidence.get(id)?.kind === 'SCREENSHOT',
    );
    state.blockage = {
      conditions,
      evidenceRefs: refs,
      recordedAt: new Date().toISOString(),
      ...(!hasScreenshot
        ? { screenshotError: screenshotError ?? 'SCREENSHOT_UNAVAILABLE' }
        : {}),
    };
  }

  /** 控制权变化时撤销全部准备声明，避免沿用另一账号或旧环境的证据。 */
  private invalidateReadiness() {
    this.interactions = new InteractionProgress();
    if (!this.isSetup()) return;
    this.workflow.invalidateAssessments();
    this.readinessEvidence = new Set(this.evidence.keys());
  }

  /** 显式条件统一驱动登录与角色交接，避免同一步先“登录”再“确认身份”重复 HITL。 */
  private identityChecks(forHandoff = false) {
    const original = this.grant.task;
    const step = original.steps?.[this.stepIndex];
    if (original.cleanupStepIds?.includes(step?.stepId ?? '')) return [];
    const shared = this.client.profileEnvironment?.();
    const guest =
      (this.environmentMode ?? shared?.mode) === 'guest' &&
      (original.sessionPlan?.mode !== 'guest' ||
        (!!original.executionPlan && (this.authRevision > 0 || forHandoff)));
    if (
      !original.executionPlan &&
      shared?.confirmedRevision === this.controlRevision
    )
      this.confirmedChecks.set('profile-guest', this.controlRevision);
    const checks = mergeChecks(
      guest ? [GUEST_CHECK] : [],
      original.sessionPlan?.candidates[0]?.checks ?? [],
      original.sessionPlan?.requirements ?? [],
      step?.preconditions ?? [],
      ...(this.recheck
        ? [
            original.steps?.find((item) => item.type === 'setup')
              ?.preconditions ?? [],
          ]
        : []),
    );
    if (original.executionPlan)
      for (const check of checks)
        if (this.confirmationKeys.has(conditionKey('identity', check)))
          this.confirmedChecks.set(check.id, this.authRevision);
        else this.confirmedChecks.delete(check.id);
    return checks;
  }

  /** 初始空白 profile 只证明准备来源；认证版本变化后改由明确的人工复核证明。 */
  private platformChecks(): NonNullable<StepResult['preconditions']> {
    return this.grant.task.executionPlan?.environment.mode === 'guest' &&
      this.authRevision === 0 &&
      this.environmentProof?.sessionId === this.grant.sessionId &&
      this.environmentProof.initialState === 'empty' &&
      !this.environmentProof.authRestored
      ? [
          {
            id: 'platform-guest',
            description: '节点已为本会话准备空白 profile，未恢复登录状态',
            status: 'SATISFIED',
            source: 'platform',
            evidenceRefs: [],
            authRevision: 0,
          },
        ]
      : [];
  }

  /** 当前步骤只采信结构化条件和本会话的人工确认，不把账号显示名解释成角色。 */
  private async checkIdentity(
    allowIntervention: boolean,
  ): Promise<VerificationReport | null> {
    const original = this.grant.task;
    const step = original.steps?.[this.stepIndex];
    if (!this.current || original.cleanupStepIds?.includes(step?.stepId ?? ''))
      return null;
    const checks = this.identityChecks();
    if (!checks.length) {
      const state = this.stepResults[this.stepIndex];
      if (state && this.platformChecks().length)
        state.preconditions = this.platformChecks();
      return null;
    }
    const evaluate = () =>
      evaluateChecks(
        checks,
        this.current!,
        this.confirmedChecks,
        this.controlRevision,
        this.grant.task.executionPlan ? this.authRevision : undefined,
      );
    let results = evaluate();
    if (this.isSetup() || original.profilePlan) {
      while (results.some((r) => r.status !== 'SATISFIED')) {
        const conditions: EnvironmentCondition[] = results
          .filter((r) => r.status !== 'SATISFIED')
          .map((r) => ({
            id: `check:${r.id}`,
            description: r.description,
            summary:
              r.status === 'UNSATISFIED'
                ? '当前观察不满足指定条件'
                : '该条件尚未确认',
            status: r.status as 'UNSATISFIED' | 'UNCONFIRMED',
          }));
        this.stepResults[this.stepIndex]!.preconditions = [
          ...this.platformChecks(),
          ...results,
        ];
        if (!allowIntervention)
          return this.blocked(
            `前置条件未满足：${conditions.map((c) => c.description).join('；')}`,
            'ENVIRONMENT_NOT_READY',
          );
        const blocked = await this.environmentNotReady(
          '账号或前置条件尚未满足',
          conditions,
        );
        if (blocked) return blocked;
        results = evaluate();
      }
      this.stepResults[this.stepIndex]!.preconditions = [
        ...this.platformChecks(),
        ...results,
      ];
      return null;
    }
    if (
      results.some((r) => r.status !== 'SATISFIED') &&
      allowIntervention &&
      original.environment.allowIntervention &&
      !this.identityInterventions.has(this.stepIndex)
    ) {
      this.identityInterventions.add(this.stepIndex);
      const revision = this.controlRevision;
      const requested = results
        .filter((r) => r.status !== 'SATISFIED')
        .slice(0, 10);
      await this.requestIntervention(
        '请确认本次测试身份及前置条件；已登录不代表账号角色符合要求',
        requested.map((r) => r.description.slice(0, 500)),
        true,
      );
      if (this.controlRevision > revision)
        for (const check of checks)
          if (
            check.method === 'manual' &&
            requested.some((r) => r.id === check.id)
          )
            this.confirmedChecks.set(
              check.id,
              this.grant.task.executionPlan
                ? this.authRevision
                : this.controlRevision,
            );
      results = evaluate();
    }
    if (this.stepResults[this.stepIndex])
      this.stepResults[this.stepIndex]!.preconditions = [
        ...this.platformChecks(),
        ...results,
      ];
    const missing = results.filter((r) => r.status !== 'SATISFIED');
    return missing.length
      ? this.blocked(
          `前置条件未满足：${missing.map((r) => r.description).join('；')}`,
          this.isSetup() ? 'ENVIRONMENT_NOT_READY' : 'PRECONDITION_UNMET',
        )
      : null;
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
        if (this.pendingNavigation) {
          // 新步骤可能已由上一步到达目标；先读当前页面，避免再次加载破坏页面状态。
          if (this.stepIndex > 0 && !this.current) await this.observe();
          if (
            this.pendingNavigation &&
            this.current?.url !== this.pendingNavigation
          ) {
            await this.command({
              type: 'browser.act',
              action: 'navigate',
              target: this.pendingNavigation,
            });
            this.current = undefined;
            this.image = undefined;
            this.settlePending = true;
          }
          this.pendingNavigation = undefined;
        }
        if (!this.current) await this.observe();
        if (
          this.grant.task.executionPlan?.environment.mode === 'guest' &&
          this.authRevision === 0 &&
          (!this.environmentProof ||
            this.environmentProof.sessionId !== this.grant.sessionId ||
            this.environmentProof.authRestored ||
            this.environmentProof.initialState !== 'empty')
        )
          return this.blocked(
            '节点未交付本会话空白访客准备证明，不能用模型声明代替',
            'ENVIRONMENT_PROOF_MISSING',
          );
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
          !this.grant.task.profilePlan &&
          (this.isSetup() || !this.loginInterventions.has(this.stepIndex)) &&
          !this.identityChecks().length &&
          needsLoginIntervention(this.grant.task, this.current!, this.stepIndex)
        ) {
          if (this.isSetup()) {
            const summary =
              '页面仍显示登录表单或人机验证，请完成当前指定账号的登录';
            const blocked = await this.environmentNotReady(
              summary,
              this.loginCondition(summary),
            );
            if (blocked) return blocked;
            errors = 0;
            continue;
          }
          if (!this.grant.task.environment.allowIntervention)
            return this.blocked(
              '当前步骤需要登录，但任务未授权人工辅助',
              this.isSetup()
                ? 'ENVIRONMENT_NOT_READY'
                : 'INTERVENTION_DISABLED',
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
        const identityBlock =
          this.setupPhase === 'PREPARING'
            ? null
            : await this.checkIdentity(true);
        if (identityBlock) return identityBlock;
        if (
          this.setupPhase === 'CHECKING' &&
          !(
            this.recheck
              ? this.grant.task.steps!.find((step) => step.type === 'setup')!
              : this.grant.task.steps![this.stepIndex]!
          ).policy.length
        ) {
          if (this.recheck) {
            this.finishRecheck();
            continue;
          }
          this.completionEvidence = this.current!.artifactRefs.map(
            (ref) => ref.artifactId,
          );
          return this.finishProfileSetup(
            '准备操作完成；本组未配置 policy，显式身份条件已核实',
          );
        }
        if (
          (this.changes?.unchangedRounds ?? 0) >= STALLED_ROUNDS ||
          ((this.changes?.repeatedStateVisits ?? 0) >= CYCLIC_VISITS &&
            this.changes?.unchangedRounds === 0)
        ) {
          const summary = '重复操作未取得新的完成证据，无法确认当前步骤已就绪';
          if (!this.isSetup() || this.grant.task.executionPlan)
            return this.blocked(summary, 'NO_PROGRESS');
          const blocked = await this.environmentNotReady(summary);
          if (blocked) return blocked;
          continue;
        }
        this.syncPolicyChecks();
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
        if (
          decision.type === 'browser.observe' &&
          (this.changes?.unchangedRounds ?? 0) >= OBSERVATION_REVIEW_ROUNDS
        )
          throw new AgentFault(
            'OBSERVATION_STALLED',
            '页面连续观察没有新增事实，请保存已验收项目后执行实际动作或明确受阻，不再重复 observe。',
          );
        if (
          this.needsEnvironmentReview() &&
          !this.environmentMode &&
          decision.type !== 'verification.environment'
        )
          throw new AgentFault(
            'INVALID_MODEL_DECISION',
            '并发前必须先声明共享环境意图，不能用 finish 冒充已完成登录状态准备',
          );
        if (decision.type === 'verification.environment') {
          if (this.grant.task.executionPlan)
            throw new AgentFault(
              'INVALID_MODEL_DECISION',
              '环境意图已在会话创建前冻结，不能运行中改写',
            );
          if (
            !this.needsEnvironmentReview() ||
            this.environmentMode ||
            this.setupPhase !== 'PREPARING'
          )
            throw new AgentFault(
              'INVALID_MODEL_DECISION',
              '共享环境声明只能在首个 setup 准备开始时提交一次',
            );
          // 显式账号选择不能被自然语言推断覆盖；冲突留给人工调整任务定义。
          if (
            decision.mode === 'guest' &&
            ['identity', 'pool'].includes(
              this.grant.task.sessionPlan?.mode ?? '',
            )
          )
            return this.blocked(
              '访客要求与指定账号配置冲突，请拆分 profile 或调整账号配置',
              'ENVIRONMENT_NOT_READY',
            );
          this.environmentMode =
            this.grant.task.sessionPlan?.mode === 'guest'
              ? 'guest'
              : decision.mode;
          this.client.declareEnvironment?.(this.environmentMode);
          const blocked = await this.checkIdentity(true);
          if (blocked) return blocked;
          this.feedback =
            this.environmentMode === 'guest'
              ? '访客准备来源已核实，仍须观察并核对原始 policy；不得把未执行的 Cookie 清理声称为自动操作。'
              : '共享环境意图已登记，继续按原始要求准备与核实，登录态复用不等于账号资格已满足。';
          continue;
        }
        if (decision.type === 'browser.act') {
          this.operation(decision);
        }
        const readings = this.interactions.validate(output.workflow?.readings);
        const readingRevision = this.interactions.view().revision;
        const revision = this.workflow.view().revision;
        this.workflow.apply(
          output.workflow,
          new Set(
            [...this.evidence.keys()].filter(
              (id) =>
                !this.isSetup() ||
                (!this.stepEvidence.has(id) && !this.readinessEvidence.has(id)),
            ),
          ),
        );
        this.syncPolicyChecks();
        this.interactions.record(readings);
        if (
          revision !== this.workflow.view().revision ||
          readingRevision !== this.interactions.view().revision
        ) {
          this.tracker.reset();
          workflowRecoveries = 0;
        }

        this.workflow.assertAction(decision);
        // 本轮登记的引文也参与防重；有明确重查原因时仍保留失败前置检查和原动作预算。
        if (decision.type === 'browser.act' && decision.action === 'click') {
          const target = this.current!.targets.find(
            (t) => t.target === decision.target,
          );
          if (target)
            this.interactions.assertClick(
              this.current!,
              target,
              output.workflow?.revisitReason,
            );
        }
        if (decision.type === 'verification.intervene') {
          if (this.isSetup()) {
            const blocked = await this.environmentNotReady(
              decision.reason,
              decision.reasonCode === 'LOGIN_REQUIRED'
                ? this.loginCondition(decision.reason)
                : undefined,
            );
            if (blocked) return blocked;
            errors = 0;
            continue;
          }
          if (!this.grant.task.environment.allowIntervention)
            return this.blocked(decision.reason, 'INTERVENTION_DISABLED');
          const login = requiresLogin(this.grant.task, this.stepIndex);
          if (login && this.loginInterventions.has(this.stepIndex))
            return this.blocked(
              '人工处理后登录条件仍未满足：' + decision.reason,
              'MODEL_BLOCKED',
            );
          await this.requestIntervention(
            decision.reason,
            decision.items,
            login,
          );
          errors = 0;
          continue;
        }
        if (
          decision.type === 'verification.record' ||
          decision.type === 'verification.finish'
        ) {
          if (decision.type === 'verification.record' && !this.grant.task.steps)
            throw new AgentFault(
              'INVALID_MODEL_DECISION',
              '逐项保存需要结构化步骤',
            );
          if (
            this.setupPhase === 'PREPARING' &&
            decision.type === 'verification.finish'
          ) {
            this.workflow.assertFinish(decision);
            const prepared = new CriteriaLedger(this.task.acceptanceCriteria);
            prepared.record(decision.criteria, this.evidence);
            this.finish(decision, prepared);
            this.criteria = prepared;
            this.currentTask = { ...this.task, acceptanceCriteria: [] };
            const step = this.grant.task.steps![this.stepIndex]!;
            this.setupPhase = 'CHECKING';
            this.stepResults[this.stepIndex]!.phase = 'CHECKING';
            this.workflow = new Workflow(
              this.task.objective,
              `${step.stepId}-policy`,
              step.policy,
            );
            this.readinessEvidence = new Set(this.evidence.keys());
            this.current = undefined;
            this.image = undefined;
            this.tracker.reset();
            this.changes = undefined;
            this.feedback =
              '准备操作已结束。现在只检查原始 policy；不得从 description 添加额外环境要求。';
            await this.client.recordSteps(this.grant, this.stepResults);
            continue;
          }
          this.assertPolicyChecks();
          const identityBlock = await this.checkIdentity(false);
          if (identityBlock) return identityBlock;
          this.syncPolicyChecks();
          // 准备结论必须先过门禁，不能提前将 FAILED 写成产品验收或保留人工处理前的部分通过。
          if (this.isSetup()) {
            if (decision.type === 'verification.record')
              throw new AgentFault(
                'INVALID_MODEL_DECISION',
                'setup 请统一提交 finish 和逐条准备证据，不逐项保存业务验收',
              );
            this.workflow.assertFinish(decision);
            if (decision.criteria.some((c) => c.verdict !== 'PASSED')) {
              if (this.grant.task.executionPlan)
                return this.blocked(decision.summary, 'ENVIRONMENT_NOT_READY');
              const blocked = await this.environmentNotReady(decision.summary);
              if (blocked) return blocked;
              continue;
            }
          } else this.workflow.assertFinish(decision);
          // TRACE 先落地再校验引用；逐项提交也必须有真实交付的证据。
          if (
            decision.criteria.some((c) =>
              this.task.acceptanceCriteria
                .find((expected) => expected.id === c.criterionId)
                ?.evidenceKinds.includes('TRACE'),
            )
          ) {
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
          }
          const currentEvidence = this.currentEvidence();
          if (this.isSetup() && decision.type === 'verification.finish') {
            // 准备结果整批提交；无效 finish 或后续人工交接不能留下半份旧账号结论。
            const ready = new CriteriaLedger(this.task.acceptanceCriteria);
            ready.record(decision.criteria, currentEvidence);
            await this.captureTrace();
            const report = this.finish(decision, ready);
            if (this.recheck) {
              this.finishRecheck();
              continue;
            }
            if (this.setupPhase === 'CHECKING')
              return this.finishProfileSetup(decision.summary);
            this.criteria = ready;
            return report;
          }
          const changed = this.criteria.record(
            decision.criteria,
            currentEvidence,
          );
          // 即使完成声明还缺其他项，也先保存本批合法结论；持久化失败则不继续业务动作。
          const state = this.stepResults[this.stepIndex];
          if (state && this.criteria.values().length) {
            state.readings = this.interactions.results();
            state.criteria = this.criteria.values();
            state.evidenceRefs = [
              ...new Set([
                ...state.criteria.flatMap((c) => c.evidenceRefs),
                ...state.readings.flatMap((item) => item.evidenceRefs),
              ]),
            ];
            state.summary = decision.summary;
            await this.client.recordSteps(this.grant, this.stepResults);
          }
          if (changed) {
            this.tracker.reset();
            this.changes = undefined;
          }
          if (decision.type === 'verification.record') {
            if (!changed) throw this.criteria.invalid('重复登记不是新进展');
            errors = 0;
            this.feedback =
              '逐项验收已保存，请继续未完成部分；finish 可补交未登记项目，或凭新增证据升级 INCONCLUSIVE/SKIPPED；已确认的通过或失败不可改写。';
            continue;
          }
          this.workflow.assertFinish(decision);
          await this.captureTrace();
          return this.finish(decision);
        }
        if (decision.type === 'verification.block') {
          if (this.isSetup()) {
            if (
              this.grant.task.executionPlan &&
              decision.reasonCode === 'OTHER'
            ) {
              this.assertPolicyChecks();
              return this.blocked(decision.summary, 'SETUP_BLOCKED');
            }
            const blocked = await this.environmentNotReady(
              decision.summary,
              decision.reasonCode === 'LOGIN_REQUIRED'
                ? this.loginCondition(decision.summary)
                : undefined,
            );
            if (blocked) return blocked;
            errors = 0;
            continue;
          }
          if (
            blockedLoginIntervention(
              this.grant.task,
              this.current!,
              this.stepIndex,
              decision,
            )
          ) {
            if (!this.grant.task.environment.allowIntervention)
              return this.blocked(decision.summary, 'INTERVENTION_DISABLED');
            if (!this.loginInterventions.has(this.stepIndex)) {
              if (decision.reasonCode === 'IDENTITY_UNCONFIRMED')
                this.identityInterventions.add(this.stepIndex);
              const step = this.grant.task.steps?.[this.stepIndex];
              await this.requestIntervention(
                decision.summary.slice(0, 1000),
                [
                  step?.description ?? this.grant.task.objective,
                  ...(step?.policy ?? []),
                ]
                  .slice(0, 8)
                  .map((item) => item.slice(0, 500)),
                true,
              );
              errors = 0;
              continue;
            }
          }
          return this.blocked(decision.summary, 'MODEL_BLOCKED');
        }
        let operation: BrowserOperation;
        if (decision.type === 'browser.act')
          operation = this.operation(decision);
        else if (decision.type === 'browser.cookies.clear') {
          if (!this.isCleanup())
            throw new AgentFault(
              'INVALID_MODEL_DECISION',
              'Cookie 清理仅用于后续清理步骤',
            );
          operation = { ...decision, url: this.task.target.url };
        } else if (decision.type === 'browser.observe') {
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
          [
            'POLICY_EVIDENCE_INCOMPLETE',
            'WORKFLOW_INCOMPLETE',
            'WORKFLOW_RECOVERY_EXHAUSTED',
            'INTERACTION_RECOVERY_REQUIRED',
            'INTERACTION_ALREADY_RECORDED',
          ].includes(error.code)
        ) {
          if (this.isSetup() || error.code === 'POLICY_EVIDENCE_INCOMPLETE') {
            if (
              this.grant.task.executionPlan &&
              ['WORKFLOW_INCOMPLETE', 'POLICY_EVIDENCE_INCOMPLETE'].includes(
                error.code,
              )
            ) {
              if (!this.incompleteFeedback.has(this.stepIndex)) {
                this.incompleteFeedback.add(this.stepIndex);
                this.feedback = `${error.message}。本次计划的取证类型：${this.grant.task.executionPlan.evidenceKinds.join('、')}；先补充可获得的证据，缺少采集能力不能交给人工冒充证明。仅需人工操作时明确 intervene。`;
                continue;
              }
              return this.blocked(
                error.message,
                error.code === 'POLICY_EVIDENCE_INCOMPLETE'
                  ? 'POLICY_EVIDENCE_INCOMPLETE'
                  : 'SETUP_EVIDENCE_INCOMPLETE',
              );
            }
            if (this.grant.task.executionPlan)
              return this.blocked(error.message, error.code);
            const blocked = await this.environmentNotReady(error.message);
            if (blocked) return blocked;
            continue;
          }
          if (++workflowRecoveries >= MAX_WORKFLOW_RECOVERIES)
            return this.blocked(
              error.message,
              error.code === 'INTERACTION_RECOVERY_REQUIRED'
                ? this.interactions.recoveryReason
                : error.code === 'INTERACTION_ALREADY_RECORDED'
                  ? 'NO_PROGRESS'
                  : error.code,
            );
          this.feedback = `${error.code}: ${error.message}`;
          continue;
        }
        if (
          error instanceof AgentFault &&
          [
            'BROWSER_TARGET_OBSCURED',
            'BROWSER_STALE_OBSERVATION',
            'BROWSER_ACTION_PRECONDITION_FAILED',
          ].includes(error.code)
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
          ![
            'INVALID_MODEL_DECISION',
            'RETRYABLE_MODEL_ERROR',
            'OBSERVATION_STALLED',
          ].includes(error.code)
        )
          throw error;
        if (++errors >= MAX_DECISION_ERRORS) {
          if (error.code === 'OBSERVATION_STALLED') {
            if (!this.isSetup() || this.grant.task.executionPlan)
              return this.blocked(error.message, 'NO_PROGRESS');
            const blocked = await this.environmentNotReady(error.message);
            if (blocked) return blocked;
            errors = 0;
            continue;
          }
          throw error;
        }
        this.feedback =
          error.code === 'OBSERVATION_STALLED'
            ? `${error.code}: ${error.message}`
            : error.message;
        if (error.code === 'RETRYABLE_MODEL_ERROR')
          await pause(200 * errors, this.guard.signal);
      }
    }
    throw new AgentFault('MODEL_TURN_BUDGET_EXCEEDED', '模型决策轮数已耗尽');
  }
  /** 接管保留原会话和动作预算，直接读取人工处理后的页面，不重放导航或刷新。 */
  private async requestIntervention(
    reason: string,
    items: string[] | undefined,
    login: boolean,
    conditionKeys?: string[],
  ) {
    if (login) this.loginInterventions.add(this.stepIndex);
    await this.client.intervene(
      this.grant,
      this.controlRevision,
      reason,
      this.guard.signal,
      items,
      this.isSetup()
        ? 'ENVIRONMENT_NOT_READY'
        : login
          ? this.loginReason() !== 'LOGIN_REQUIRED'
            ? this.loginReason()
            : this.identityInterventions.has(this.stepIndex)
              ? 'IDENTITY_CHECK_UNMET'
              : 'LOGIN_REQUIRED'
          : 'GENERAL',
      conditionKeys,
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

  /** setup 未就绪时停止全部后续步骤，包括 cleanup；会话资源回收由控制面负责。 */
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
    let setupFailure: VerificationReport | undefined;
    const cleanupIds = new Set(this.grant.task.cleanupStepIds ?? []);
    for (; this.stepIndex < steps.length; this.stepIndex++) {
      const step = steps[this.stepIndex]!;
      const state = this.stepResults[this.stepIndex]!;
      this.guard.signal.throwIfAborted();
      if (setupFailure) {
        state.status = 'SKIPPED';
        state.reasonCode =
          setupFailure.executionDetails?.reasonCode ?? 'SETUP_FAILED';
        state.summary = `验证环境未就绪，本步骤未执行（含后续清理）：${setupFailure.summary}`;
        state.finishedAt = new Date().toISOString();
        await this.client.recordSteps(this.grant, this.stepResults);
        continue;
      }
      // 相同入口的连续步骤继承当前页面，包括站点重定向、语言及团队选择。
      if (this.stepIndex > 0 && steps[this.stepIndex - 1]!.url !== step.url)
        this.pendingNavigation = step.url;
      this.currentTask = undefined;
      this.recheck = undefined;
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
      this.setupPhase =
        this.grant.task.profilePlan && this.isSetup() ? 'PREPARING' : undefined;
      if (this.grant.task.profilePlan)
        state.phase = this.isCleanup()
          ? 'CLEANUP'
          : (this.setupPhase ?? 'VERIFYING');
      this.workflow = new Workflow(
        this.currentTask.objective,
        step.stepId,
        this.isSetup()
          ? [step.description, ...(this.setupPhase ? [] : step.policy)]
          : undefined,
      );
      this.readinessEvidence = new Set(this.evidence.keys());
      this.criteria = new CriteriaLedger(this.currentTask.acceptanceCriteria);
      this.stepEvidence = new Set(this.evidence.keys());
      this.completionEvidence = [];
      this.current = undefined;
      this.image = undefined;
      this.feedback = null;
      this.interactions = new InteractionProgress();
      this.settlePending = false;
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
          report =
            step.expected.length || this.isSetup() || step.policyChecks?.length
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
      }
      state.readings = this.interactions.results();
      state.criteria = this.criteria.values();
      state.reasonCode = report.executionDetails?.reasonCode ?? null;
      if (report.executionDisposition !== 'EXECUTED') {
        if (
          !this.isCleanup() &&
          !this.guard.signal.aborted &&
          ![
            'BROWSER_EFFECT_UNKNOWN',
            'LEASE_LOST',
            'EXECUTION_ENDED',
            'EXECUTION_EXPIRED',
          ].includes(report.executionDetails?.reasonCode ?? '')
        )
          await this.preserveBlockage(
            report.executionDisposition === 'BLOCKED',
          );
        if (
          this.isSetup() ||
          (this.grant.task.profilePlan &&
            report.executionDetails?.reasonCode === 'ENVIRONMENT_NOT_READY')
        )
          setupFailure = report;
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
        // 未知效果已使控制面撤权，先保留原始故障；最终报告阶段再尽力保存步骤，避免 409 覆盖根因。
        if (
          this.guard.signal.aborted ||
          [
            'BROWSER_EFFECT_UNKNOWN',
            'LEASE_LOST',
            'EXECUTION_ENDED',
            'EXECUTION_EXPIRED',
          ].includes(report.executionDetails?.reasonCode ?? '')
        )
          break;
        if (!this.guard.signal.aborted)
          await this.client.recordSteps(this.grant, this.stepResults);
        continue;
      }
      state.status = 'COMPLETED';
      if (this.isSetup() && this.grant.task.profilePlan) {
        state.phase = 'READY';
        this.readyRevision = this.grant.task.executionPlan
          ? this.authRevision
          : this.controlRevision;
      }
      state.summary = report.summary;
      state.criteria = report.criteria;
      state.evidenceRefs = [
        ...new Set([
          ...this.completionEvidence,
          ...state.readings.flatMap((item) => item.evidenceRefs),
        ]),
      ];
      state.finishedAt = new Date().toISOString();
      await this.client.recordSteps(this.grant, this.stepResults);
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

  /** 人工分类只接受封闭集合，节点任意错误字符串不能污染统计维度。 */
  private loginReason():
    | 'LOGIN_REQUIRED'
    | 'LOGIN_RECIPE_MISSING'
    | 'LOGIN_RECIPE_UNAVAILABLE'
    | 'LOGIN_FORM_MISMATCH'
    | 'LOGIN_CHALLENGE_OR_REJECTED' {
    switch (this.preparationReason) {
      case 'LOGIN_RECIPE_MISSING':
      case 'LOGIN_RECIPE_UNAVAILABLE':
      case 'LOGIN_FORM_MISMATCH':
      case 'LOGIN_CHALLENGE_OR_REJECTED':
        return this.preparationReason;
      default:
        return 'LOGIN_REQUIRED';
    }
  }

  /** 身份准备占用独立额度，不扣业务动作或模型次数；失败仍由逐步门禁判断。 */
  private async prepareIdentity(): Promise<void> {
    const plan = this.grant.task.sessionPlan;
    const identity = plan?.candidates[0];
    if (!identity || this.identityPrepared) return;
    for (;;) {
      await this.checkpoint();
      const view = await this.client.view(this.grant, this.guard.signal);
      if (view.taskState !== 'RUNNING')
        throw new AgentFault('EXECUTION_ENDED', '任务已结束');
      if (view.state === 'RUNNING') break;
      await pause(POLL_MS, this.guard.signal);
    }
    const checks = [...identity.checks, ...plan!.requirements];
    const operation: BrowserOperation = {
      type: 'browser.identity.prepare',
      url: this.grant.task.target.url,
      ...(identity.loginRef ? { profileRef: identity.loginRef } : {}),
      checks: checks
        .filter((c) => c.method !== 'manual')
        .map((c) => ({
          method: c.method as 'text' | 'absent',
          value: c.value!,
        })),
      saveSnapshot: checks.every((c) => c.method !== 'manual'),
    };
    // 发送前固定已尝试标记；即使回执不明，也不能换一个命令 ID 再次提交。
    this.identityPrepared = true;
    try {
      const prepared = await this.command(operation, plan!.preparationMs);
      this.preparationReason =
        typeof prepared.data?.reasonCode === 'string'
          ? prepared.data.reasonCode
          : undefined;
    } catch (error) {
      if (
        !(error instanceof AgentFault) ||
        error.code !== 'BROWSER_COMMAND_FAILED'
      )
        throw error;
      // 明确拒绝的配置故障可继续业务观察/人工处理，未知副作用仍遵循原有停止规则。
    }
  }

  /** 无论正常还是异常都提交一次不可变报告；提交失败交给调用者记录，租约负责最终回收。 */
  async run(): Promise<VerificationReport> {
    try {
      for (;;) {
        let report: VerificationReport;
        try {
          await this.prepareIdentity();
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
        if (!this.grant.task.profilePlan && !validateVerificationReport(report))
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
  return grant.task.profilePlan
    ? executeProfile(config, client, model, grant, stop, executeSingle)
    : executeSingle(config, client, model, grant, stop);
}

/** 子组复用单组执行器，最终报告由 profile 编排器统一提交。 */
export function executeSingle(
  config: AgentConfig,
  client: ExecutionClient,
  model: DecisionModel,
  grant: ExecutionGrant,
  stop: AbortSignal,
): Promise<VerificationReport> {
  return new Execution(config, client, model, grant, stop).run();
}
