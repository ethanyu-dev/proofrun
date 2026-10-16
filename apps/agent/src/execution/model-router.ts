import {
  ChatModel,
  decisionData,
  type DecisionInput,
  type DecisionModel,
  type DecisionOutput,
} from '../model/chat.js';
import { JevSelector, type JevSelection } from '../model/jev-selector.js';
import { boundContext, type DecisionContextData } from './context.js';
import { planFields } from './plan-inputs.js';
import { plannedFeedback } from '../prompts/planned.js';
import { AgentFault, transient } from '../http.js';
import type { AgentConfig } from '../config.js';

/** 首版批量复核上限保证待核对正文不会一直挤出当前上下文。 */
const READING_BATCH = 4;
/** 低预算时直接复核，避免候选和回退同时耗尽最后一次收尾机会。 */
const REVIEW_CALL_RESERVE = 2;
/** 公共观察计数的复核阈值；终止阈值仍由原执行器管理。 */
const UNCHANGED_REVIEW = 2;
const REPEATED_REVIEW = 3;
/** 旧调用端未提供字符上限时沿用公共默认值。 */
const DEFAULT_CONTEXT_CHARS = 64_000;
/** 只对供应商选择失败回退；预算、审计持久化、撤权等错误必须继续向外抛出。 */
const SELECTOR_FAILURES = new Set([
  'INVALID_MODEL_DECISION',
  'MODEL_CONTEXT_TOO_LARGE',
]);

/** 路由原因来自执行事实，中文提示仅用于解释，不参与控制流。 */
export interface ReviewEvent {
  /** 固定原因集合，是执行层分支依据。 */
  code:
    | 'CONTINUE'
    | 'PLAN_REQUIRED'
    | 'CHECKPOINT'
    | 'DECISION_GAP'
    | 'EXECUTION_EXCEPTION'
    | 'ENVIRONMENT_CHANGED'
    | 'SETTLEMENT';
  /** 稳定诊断或候选缺口，不代表业务验收结论。 */
  detail?: string;
}
/** 每个执行组拥有自己的检查点游标；不保存第二份页面历史或循环计数。 */
export interface PolicyContext {
  /** 随请求存档的冻结策略版本。 */
  version: 'planned-v1';
  /** 由执行器生成，涵盖步骤、准备阶段、控制代次与身份代次。 */
  scope: string;
  /** 按优先级选出的本轮主要原因。 */
  event: ReviewEvent;
  /** 最近一次已接受的文本复核之前最后一个动作，防止重复消费检查点。 */
  reviewedCommandId?: string | undefined;
  /** 当前步骤已发生的候选供应商故障，后续直接使用文本模型。 */
  selectorUnavailable?: string | undefined;
}

/** 统一优先级；同轮多个条件只触发一次文本请求，全部事实仍保留在上下文。 */
export function executionEvent(context: DecisionContextData): ReviewEvent {
  if (context.verificationReview?.final || context.budgetRemaining.actions <= 0)
    return {
      code: 'SETTLEMENT',
      detail: context.verificationReview?.reason ?? '动作额度耗尽或执行停滞',
    };
  const pending = context.executionPolicy?.event;
  if (pending && pending.code !== 'CONTINUE') return pending;
  if (context.environmentReview?.required)
    return { code: 'ENVIRONMENT_CHANGED', detail: '需要声明共享环境意图' };
  if (context.cleanup || context.setupPhase === 'CHECKING')
    return { code: 'CHECKPOINT', detail: '核对准备条件或清理结果' };
  if (context.workflow?.activeStep === null)
    return { code: 'CHECKPOINT', detail: '原始要求已登记，整理最终结论' };
  if (!context.plan) return { code: 'PLAN_REQUIRED' };
  if (context.executionPolicy?.selectorUnavailable)
    return {
      code: 'EXECUTION_EXCEPTION',
      detail: `候选服务已降级：${context.executionPolicy.selectorUnavailable}`,
    };
  if (context.budgetRemaining.modelCalls <= REVIEW_CALL_RESERVE)
    return {
      code: 'CHECKPOINT',
      detail: '剩余调用只够文本决策和收尾，不再先派发候选请求',
    };
  if (context.plan.remaining === 0)
    return { code: 'EXECUTION_EXCEPTION', detail: '局部计划额度耗尽' };
  if (
    (context.changes?.unchangedRounds ?? 0) >= UNCHANGED_REVIEW ||
    (context.changes?.repeatedStateVisits ?? 0) >= REPEATED_REVIEW
  )
    return {
      code: 'EXECUTION_EXCEPTION',
      detail: '公共观察检测到无变化或返回重复状态',
    };
  const captured =
    context.interactionProgress?.items.filter((i) => i.status === 'observed') ??
    [];
  if (
    captured.length &&
    (!context.plan.collectReadings ||
      captured.length >= READING_BATCH ||
      context.interactionProgress!.omittedItems > 0 ||
      captured.some((i) => i.truncated))
  )
    return { code: 'CHECKPOINT', detail: '批量核对已采集面板及覆盖范围' };
  const last = context.recentOperations.findLast(
    (op) => op.operation === 'browser.act',
  );
  if (
    last &&
    last.commandId !== context.executionPolicy?.reviewedCommandId &&
    last.operationStatus === 'SUCCEEDED' &&
    last.effect === 'COMPLETED'
  ) {
    const checkpoint = ['fill', 'type'].includes(last.action ?? '')
      ? 'after-fill'
      : last.action === 'click'
        ? 'after-click'
        : [
              'navigate',
              'reload',
              'back',
              'forward',
              'frame',
              'tab.new',
              'tab.switch',
            ].includes(last.action ?? '')
          ? 'after-navigation'
          : undefined;
    if (checkpoint && context.plan.checkpoints?.includes(checkpoint))
      return { code: 'CHECKPOINT', detail: checkpoint };
  }
  return { code: 'CONTINUE' };
}

/** 为请求生成可追踪的复核视图；只替换路由元数据，不丢弃原始观察或既有反馈。 */
function reviewInput(
  input: DecisionInput,
  event: ReviewEvent,
  requests: number,
  elapsedMs: number,
): DecisionInput {
  const context = structuredClone(decisionData(input));
  if (!context.executionPolicy)
    throw new AgentFault(
      'INVALID_EXECUTION_POLICY',
      '统一模型路由缺少执行器快照',
    );
  context.executionPolicy.event = event;
  // 同轮候选及 Box 已经消耗的请求与时间也必须体现在复核快照中。
  context.budgetRemaining.modelCalls = Math.max(
    0,
    context.budgetRemaining.modelCalls - requests,
  );
  context.budgetRemaining.timeMs = Math.max(
    0,
    Math.floor(context.budgetRemaining.timeMs - elapsedMs),
  );
  context.feedback = [
    plannedFeedback(event.code, event.detail),
    context.feedback,
  ]
    .filter(Boolean)
    .join(' ');
  const bounded = boundContext(
    context,
    input.observation ?? context.observation,
    input.contextLimit ?? DEFAULT_CONTEXT_CHARS,
  );
  return { ...input, ...bounded };
}

/** 调度仅依赖当前快照；JEV 适配器不持有文本模型，所有回退都经过此处。 */
export class PlannedModel implements DecisionModel {
  constructor(
    /** 文本供应商统一处理规划、复核与最终决定。 */
    private readonly text: DecisionModel,
    /** 纯 LLM 模式不配置候选供应商。 */
    private readonly selector?: JevSelector,
  ) {}
  /** tab 间只共享无状态代码；供应商能力诊断也独立。 */
  fork(): DecisionModel {
    return new PlannedModel(
      this.text.fork?.() ?? this.text,
      this.selector?.fork(),
    );
  }
  /** 一次执行轮可包含选择和复核，真实请求逐次走同一预算与审计回调。 */
  async decide(
    input: DecisionInput,
    signal: AbortSignal,
  ): Promise<DecisionOutput> {
    const context = decisionData(input);
    const started = performance.now();
    let requests = 0;
    const tracked: DecisionInput = {
      ...input,
      recordRequest: (model) => {
        input.recordRequest?.(model);
        requests++;
      },
    };
    if (!context.executionPolicy)
      throw new AgentFault('INVALID_EXECUTION_POLICY', '缺少统一执行上下文');
    const review = async (
      event: ReviewEvent,
      usage = { promptTokens: 0, completionTokens: 0 },
    ) => {
      const output = await this.text.decide(
        reviewInput(tracked, event, requests, performance.now() - started),
        signal,
      );
      return {
        ...output,
        reviewed: true,
        promptTokens: output.promptTokens + usage.promptTokens,
        completionTokens: output.completionTokens + usage.completionTokens,
      };
    };
    const event = context.executionPolicy.event;
    if (!this.selector || event.code !== 'CONTINUE') return review(event);
    let selected: JevSelection;
    try {
      selected = await this.selector.select(tracked, signal);
    } catch (error) {
      if (
        !signal.aborted &&
        error instanceof AgentFault &&
        (SELECTOR_FAILURES.has(error.code) || transient(error))
      )
        return {
          ...(await review({
            code: 'EXECUTION_EXCEPTION',
            detail: `候选选择失败：${error.code}`,
          })),
          selectorUnavailable: error.code,
        };
      throw error;
    }
    if (selected.kind === 'review')
      return review(
        { code: selected.reasonCode, detail: selected.reason },
        selected,
      );
    if (selected.kind === 'action')
      return {
        decision: selected.decision,
        promptTokens: selected.promptTokens,
        completionTokens: selected.completionTokens,
      };
    const page = input.observation ?? context.observation;
    const field = planFields(page).find(
      (f) => f.target === selected.candidate.target,
    );
    const value =
      field && context.plan?.inputs?.find((i) => i.key === field.key)?.value;
    if (value === undefined)
      return review(
        {
          code: 'DECISION_GAP',
          detail:
            '所选字段没有有效的计划填写值；核对任务约束后直接填写或明确阻塞',
        },
        selected,
      );
    return {
      decision: {
        type: 'browser.act',
        action: 'fill',
        target: selected.candidate.target,
        value,
      },
      promptTokens: selected.promptTokens,
      completionTokens: selected.completionTokens,
    };
  }
}

/** 工厂只选择供应商组合；业务任务和账号授权仍由执行器负责。 */
export function plannedModel(
  config: AgentConfig,
  jev: boolean,
  key: string,
  model?: string,
): DecisionModel {
  return new PlannedModel(
    new ChatModel(config),
    jev ? new JevSelector(config, key, model) : undefined,
  );
}
