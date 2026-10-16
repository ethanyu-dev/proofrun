import {
  FIELD_VALUE_PROMPT,
  FIELD_RESULT_REVIEW,
  fieldValueRecovery,
  JEV_VISUAL_TARGET,
  JEV_VISUAL_EXISTS,
  JEV_VISUAL_UNIQUE,
  JEV_CONTROL_CHOICES,
  JEV_VISUAL_OPTION,
  JEV_VISUAL_COUNTS,
  reviewFeedback,
  FINAL_REVIEW_REASON,
  ACTIONS_EXHAUSTED_REASON,
  unassociatedTargetReview,
} from '../prompts/jev.js';
import type { AgentDecision } from '@proofrun/contracts';
import { DEFAULT_JEV_MODEL, type AgentConfig } from '../config.js';
import type { Observation } from '../evidence/observation.js';
import { AgentFault, jsonRequest } from '../http.js';
import { modelRequest } from './request.js';
import { candidates, estimatedTokens, type Candidate } from './candidates.js';
import { JevProgress, evidenceExcerpt } from './jev-progress.js';
import { jevQuestions, EXPANDED_ACTION_LIMIT } from './jev-questions.js';
import {
  prepareJevImage,
  JEV_IMAGE_TOKEN_RESERVE,
  JEV_REQUEST_BYTES,
  type JevImage,
} from './jev-image.js';
import { jevBoxPoint, supportsJevBox } from './jev-box.js';
import {
  ChatModel,
  type DecisionInput,
  type DecisionModel,
  type DecisionOutput,
} from './chat.js';

/** JEV 只提供有限候选判断；填充值和按证据验收使用配置中的文本模型。 */
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** 单 Choice 最多 255 项；200 个动作给五个控制选项和后续扩展留余量。 */
const ACTION_LIMIT = 200;
/** 默认单问题上限为 32k token；字符保护与保守估算独立，预留服务端模板开销。 */
const DEFAULT_CONTEXT = {
  requestChars: 64_000,
  tokens: 28_000,
  pageChars: 14_000,
};
/** 实验模式低于官方 262k token 上限，只放宽请求和当前页；共享上下文上限仍先执行。 */
const LONG_CONTEXT = {
  requestChars: 256_000,
  tokens: 224_000,
  pageChars: 64_000,
};
/** 仅 TypeSafe 决策请求需要此实验头，不能传播到填写或验收模型。 */
const LONG_CONTEXT_HEADER = 'TypeSafe-Danger-Zone-Long-Context';

/** 选择必须属于本轮候选，概率不可缺项、越界或与最大概率冲突。 */
export function jevChoice(
  answer: unknown,
  candidates: Record<string, unknown>,
): { choice: string; confidence: number } {
  const a = answer as
    | {
        choice?: string;
        confidence?: number;
        probabilities?: Record<string, number>;
      }
    | undefined;
  const ids = Object.keys(candidates);
  const p = a?.probabilities;
  if (
    !a ||
    !p ||
    !ids.includes(a.choice ?? '') ||
    Object.keys(p).length !== ids.length ||
    !ids.every((id) => Number.isFinite(p[id]) && p[id]! >= 0 && p[id]! <= 1) ||
    !Number.isFinite(a.confidence) ||
    a.confidence! < 0 ||
    a.confidence! > 1 ||
    Math.abs(Object.values(p).reduce((x, y) => x + y, 0) - 1) > 0.02 ||
    p[a.choice!]! + 1e-6 < Math.max(...Object.values(p))
  )
    throw new AgentFault(
      'INVALID_MODEL_DECISION',
      'JEV 返回了不属于当前候选的决定',
    );
  return { choice: a.choice!, confidence: a.confidence! };
}

/** 每个执行独立实例，所有动作仍由原执行器、控制面与节点校验。 */
export class JevModel implements DecisionModel {
  /** 与对照组使用同一配置，负责自由文本和按证据验收。 */
  private readonly text: DecisionModel;
  /** 图片参数被供应商拒绝后，本次执行不重复发送同类图片请求。 */
  private imageRejection: string | undefined;
  /** 跨栏目证据及循环检测只在当前执行内生效。 */
  private readonly progress = new JevProgress();
  /** 公共执行器确认有新的步骤证据后，才清除局部循环计数。 */
  private revision = 0;
  /** 结构化步骤身份只能由执行器推进，切换后允许重新访问相同业务页面。 */
  private structuredStep: string | undefined;
  /** 填写后的第一轮核对真实提示；同一回执不会重复触发文本审查。 */
  private reviewedFieldCommand: string | undefined;
  constructor(
    /** 共用超时与文本模型设置。 */
    private readonly config: AgentConfig,
    /** 仅发往固定 TypeSafe 端点的服务凭据。 */
    private readonly key: string,
    /** TypeSafe 模型名，报告按真实请求分别计数。 */
    private readonly model = DEFAULT_JEV_MODEL,
    /** 测试可注入请求端口；生产固定使用 TypeSafe 地址。 */
    private readonly request: typeof jsonRequest = jsonRequest,
    /** 测试替换审查器，不影响生产模型配置。 */
    reviewer?: DecisionModel,
  ) {
    this.text = reviewer ?? new ChatModel(config);
  }
  /** tab 之间不共享页面历史、停滞计数或工作流代次，文本审查器也按相同规则隔离。 */
  fork(): DecisionModel {
    return new JevModel(
      this.config,
      this.key,
      this.model,
      this.request,
      this.text.fork?.() ?? this.text,
    );
  }
  /** 将当前页面转换为有限候选；输出仍遵守原执行器的动作协议。 */
  async decide(
    input: DecisionInput,
    signal: AbortSignal,
  ): Promise<DecisionOutput> {
    if (!this.key)
      throw new AgentFault('JEV_NOT_CONFIGURED', 'JEV 组缺少 TypeSafe 配置');
    const context: import('../execution/context.js').DecisionContextData =
      input.context ?? JSON.parse(input.text);
    // 环境意图必须由拥有完整原始约束的文本模型单独声明，不能被动作提案跳过。
    if (context.environmentReview?.required)
      return this.text.decide(input, signal);
    if (
      context.executionStep &&
      context.executionStep.stepId !== this.structuredStep
    ) {
      this.progress.advanced();
      this.structuredStep = context.executionStep.stepId;
      this.reviewedFieldCommand = undefined;
    }
    const page = input.observation ?? context.observation;
    if (page.observationId !== context.observation.observationId)
      throw new AgentFault(
        'EVIDENCE_MISMATCH',
        '原始观察与模型上下文不属于同一轮',
      );
    const stage = context.workflow?.steps.find(
      (s) => s.id === context.workflow?.activeStep,
    );
    const objective =
      context.executionGuidance && context.workflow?.recovery
        ? context.workflow.recovery.goal
        : (stage?.requirement ?? context.task.objective);
    const recovery = context.workflow?.recovery;
    if (context.workflow && context.workflow.revision !== this.revision) {
      this.progress.advanced();
      this.revision = context.workflow.revision;
    }
    this.progress.observe(page, objective);
    // 使用和 LLM 相同的当前正文，额外记忆必须服从原上下文上限。
    const history = this.progress.history();
    const enriched = {
      ...context,
      previousObservations: history,
      jevProgress: this.progress.summary(),
    };
    while (
      history.length &&
      JSON.stringify(enriched).length > this.config.maxContextChars - 2000
    )
      history.shift();
    const review = async (reason: string): Promise<DecisionOutput> => {
      // 复核视图添加了独立历史与反馈，不能同时携带原来的类型化快照冒充同一份上下文。
      const { context: _context, ...reviewInput } = input;
      const output = await this.text.decide(
        {
          ...reviewInput,
          text: JSON.stringify({
            ...enriched,
            feedback: reviewFeedback(reason, context.feedback),
          }),
        },
        signal,
      );
      console.log(
        JSON.stringify({
          event: 'jev.review',
          taskId: context.task.taskId,
          reason,
          decision: output.decision.type,
          progress: this.progress.summary(),
        }),
      );
      this.progress.reviewed();
      return output;
    };
    const lastAction = context.recentOperations?.findLast(
      (operation) => operation.operation === 'browser.act',
    );
    const fieldChanged =
      lastAction &&
      ['fill', 'type'].includes(lastAction.action ?? '') &&
      lastAction.operationStatus === 'SUCCEEDED' &&
      lastAction.effect === 'COMPLETED' &&
      (!context.actionMemory ||
        context.actionMemory.items.some(
          (item) => item.commandId === lastAction.commandId,
        )) &&
      lastAction.commandId !== this.reviewedFieldCommand;
    const reason = context.verificationReview?.final
      ? context.verificationReview.reason === 'budget'
        ? '原预算内最后一次只读验收整理：只提交已有证据支持的结论和缺口，不再探索'
        : FINAL_REVIEW_REASON
      : context.budgetRemaining.actions <= 0
        ? ACTIONS_EXHAUSTED_REASON
        : fieldChanged
          ? FIELD_RESULT_REVIEW
          : context.executionGuidance?.review &&
              ![
                'TASK_PROGRESS',
                'TARGET_LOCATED',
                'WORK_BUDGET_LOW',
                'BUDGET_LOW',
              ].includes(context.executionGuidance.review)
            ? `执行器复核事件 ${context.executionGuidance.review}：根据当前子目标、剩余验收项、位置线索与预算调整执行计划`
            : context.interactionProgress?.items.some(
                  (item) => item.status === 'observed',
                )
              ? '新展开的面板已取得原文，请先通过 workflow.readings 登记子项，再继续尚未读取的问题；记录不等于验收通过'
              : context.cleanup
                ? '后续清理由文本模型核对明确的恢复条件及 Cookie 清理回执，满足后及时结束'
                : context.verificationReview
                  ? '阶段性核对尚未登记的验收项：先用 verification_record 保存已有充分证据的独立结论，再处理剩余交互；没有充分证据不能编造通过'
                  : typeof context.feedback === 'string' &&
                      /^(CRITERIA_ALREADY_RECORDED:|PREPARATION_REVIEW:|WORKFLOW_|INTERACTION_RECOVERY_REQUIRED:|INTERACTION_ALREADY_RECORDED:|OBSERVATION_STALLED:|BROWSER_TARGET_OBSCURED:|BROWSER_STALE_OBSERVATION:|BROWSER_ACTION_PRECONDITION_FAILED:)/u.test(
                        context.feedback,
                      )
                    ? '执行器反馈步骤缺口、预算耗尽或动作目标失效；请核对当前状态并改变恢复策略，无法继续时 verification.block'
                    : context.workflow?.activeStep === null
                      ? '全部原始步骤已登记证据，请按原 criterionId 整理最终结论，避免继续浏览'
                      : recovery?.remaining === 0
                        ? '恢复计划动作预算耗尽，核对成功条件；未成功时改变策略或停止，不能重复同一计划'
                        : context.executionGuidance
                          ? undefined
                          : this.progress.reviewReason(
                              context.budgetRemaining.actions,
                              !!recovery && recovery.remaining > 0,
                            );
    if (reason) {
      const output = await review(reason);
      // 请求失败不能吞掉填写后的核对机会；下一轮仍需要检查提示。
      if (fieldChanged) this.reviewedFieldCommand = lastAction.commandId;
      return output;
    }
    const readings = new Map(
      context.interactionProgress?.currentTargets?.map((item) => [
        item.target,
        item,
      ]),
    );
    const available = candidates(
      page.targets,
      objective,
      stage
        ? {
            ...(recovery
              ? { scope: recovery.scope, terms: recovery.terms }
              : {}),
          }
        : undefined,
      this.config.jevExpandedActions === true,
    )
      .filter((candidate) => {
        if (!context.executionGuidance || !recovery?.allowedActions)
          return true;
        const action = candidate.operation.startsWith('SCROLL_')
          ? 'scroll'
          : candidate.operation === 'TYPE_TEXT'
            ? 'fill'
            : candidate.operation.toLowerCase();
        return recovery.allowedActions.includes(action);
      })
      // 已读控件不再作为普通点击候选竞争；必要重访只能经 REPLAN 由文本模型说明原因。
      .filter(
        (candidate) =>
          candidate.operation !== 'CLICK' ||
          readings.get(candidate.target)?.status !== 'recorded',
      )
      .map((candidate) => ({
        ...candidate,
        field: { ...candidate.field, reading: readings.get(candidate.target) },
      }))
      .sort(
        (a, b) =>
          Number(a.field.reading?.status === 'recorded') -
          Number(b.field.reading?.status === 'recorded'),
      );
    const expanded = this.config.jevExpandedActions === true;
    const selected = available.slice(
      0,
      expanded ? EXPANDED_ACTION_LIMIT : ACTION_LIMIT,
    );
    let picture: JevImage | undefined;
    if (this.config.jevImages && input.image && !this.imageRejection) {
      try {
        picture = await prepareJevImage(input.image, page);
      } catch (error) {
        if (error instanceof AgentFault && error.code === 'JEV_IMAGE_INVALID')
          return review('当前截图不能用于 JEV，交给文本审查核对已有证据');
        throw error;
      }
    }
    const boxEnabled =
      !!picture &&
      this.config.jevBox === true &&
      this.model === 'jev-1.14.0' &&
      supportsJevBox(page);
    // 变化排序后的动作共享一份简短字段说明，不重复完整 DOM 行。
    const controls: Record<string, unknown> = { ...JEV_CONTROL_CHOICES };
    if (
      context.executionGuidance &&
      recovery?.allowedActions &&
      !recovery.allowedActions.includes('scroll')
    ) {
      delete controls.SCROLL_UP;
      delete controls.SCROLL_DOWN;
    }
    if (
      boxEnabled &&
      (!context.executionGuidance ||
        !recovery?.allowedActions ||
        recovery.allowedActions.includes('visual.click'))
    )
      controls.VISUAL_LOCATE = JEV_VISUAL_OPTION;
    const actions = new Map<string, Candidate>();
    for (const candidate of selected) {
      const id = `A${actions.size + 1}`;
      actions.set(id, candidate);
    }
    let selection = jevQuestions(actions, controls, expanded);
    const compactHistory = history.map((p) => ({
      ...p,
      text: evidenceExcerpt(p.text, objective, 2000),
      truncated: p.truncated || p.text.length > 2000,
    }));
    const budget = this.config.jevLongContext ? LONG_CONTEXT : DEFAULT_CONTEXT;
    const compactText = evidenceExcerpt(page.text, objective, budget.pageChars);
    const body = {
      model: this.model,
      state: {
        ...enriched,
        previousObservations: compactHistory,
        candidates: selection.fields,
        screenshot: picture?.reference,
        screenshotSource: picture?.metadata,
        imageUnavailable:
          this.imageRejection ??
          (this.config.jevImages && !picture
            ? '当前观察没有可用截图'
            : undefined),
        observation: {
          ...page,
          text: compactText,
          textTruncated: page.truncated === true || compactText !== page.text,
          targets: undefined,
        },
        omittedTargets:
          new Set(available.map((a) => a.target)).size -
          new Set(selected.map((a) => a.target)).size,
        candidateCoverage: {
          sourceTargets: page.targets.length,
          textViewTargets: context.observation.targets.length,
          totalActions: available.length,
          returnedActions: selected.length,
          omittedActions: available.length - selected.length,
          reason: available.length > selected.length ? 'action_limit' : null,
        },
      },
      questions: selection.questions,
    };
    const tokenEstimate = () =>
      estimatedTokens(body) + (picture ? JEV_IMAGE_TOKEN_RESERVE : 0);
    while (
      compactHistory.length &&
      (JSON.stringify(body).length > budget.requestChars ||
        tokenEstimate() > budget.tokens)
    )
      compactHistory.shift();
    // 先移除低优先级候选，再转交审查；新增弹层候选排在前面，不因页尾位置被裁剪。
    while (
      (JSON.stringify(body).length > budget.requestChars ||
        tokenEstimate() > budget.tokens) &&
      actions.size > 1
    ) {
      // 每轮移除低优先级尾部的一小批，避免两千候选逐个重建导致平方级序列化成本。
      const removed = Math.min(
        actions.size - 1,
        Math.max(1, Math.ceil(actions.size / 10)),
      );
      for (const id of [...actions.keys()].slice(-removed)) actions.delete(id);
      selection = jevQuestions(actions, controls, expanded);
      body.questions = selection.questions;
      body.state.candidates = selection.fields;
      body.state.candidateCoverage.returnedActions = actions.size;
      body.state.candidateCoverage.omittedActions =
        available.length - actions.size;
      body.state.candidateCoverage.reason = 'context_budget';
      body.state.omittedTargets =
        new Set(available.map((a) => a.target)).size -
        new Set([...actions.values()].map((a) => a.target)).size;
    }
    if (
      JSON.stringify(body).length > budget.requestChars ||
      tokenEstimate() > budget.tokens
    )
      return review(
        '当前页面候选与任务定义超过 JEV 请求预算，使用完整上下文核对下一步',
      );
    const headers: Record<string, string> = {};
    if (picture) headers['TypeSafe-Danger-Zone-Images'] = 'true';
    if (this.config.jevLongContext && tokenEstimate() > DEFAULT_CONTEXT.tokens)
      headers[LONG_CONTEXT_HEADER] = 'true';
    const payload = {
      ...body,
      ...(picture ? { assets: { [picture.reference]: picture.asset } } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(payload)) > JEV_REQUEST_BYTES)
      return review('JEV 图片请求超过传输预算，交给文本审查');
    type Reply = {
      answers?: Record<string, unknown>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const send = async (
      requestBody: Record<string, unknown>,
    ): Promise<Reply> => {
      signal.throwIfAborted();
      // Box 的问题与主选择不同，逐次计算实验头，不能继承第一次请求的长度判断。
      const { assets: _assets, ...textBody } = requestBody;
      const requestHeaders = { ...headers };
      if (
        this.config.jevLongContext &&
        estimatedTokens(textBody) + (picture ? JEV_IMAGE_TOKEN_RESERVE : 0) >
          DEFAULT_CONTEXT.tokens
      )
        requestHeaders[LONG_CONTEXT_HEADER] = 'true';
      else delete requestHeaders[LONG_CONTEXT_HEADER];
      return (await modelRequest(
        input,
        this.model,
        'JEV_SELECTION',
        requestBody,
        () =>
          this.request(
            ENDPOINT,
            this.key,
            'POST',
            requestBody,
            this.config.modelMs,
            signal,
            Object.keys(requestHeaders).length ? requestHeaders : undefined,
          ),
      )) as Reply;
    };
    const rejected = (error: unknown): string | undefined => {
      if (!(error instanceof AgentFault)) return undefined;
      if (error.code === 'MODEL_CONTEXT_TOO_LARGE')
        return 'JEV 服务拒绝上下文长度，转交文本模型核对完整证据';
      if (picture && (error.status === 400 || error.status === 413)) {
        this.imageRejection = '供应商拒绝图片请求，本次执行回到文本候选';
        return this.imageRejection;
      }
      return undefined;
    };
    let raw: Reply;
    try {
      raw = await send(payload);
    } catch (error) {
      const reason = rejected(error);
      if (reason) return review(reason);
      throw error;
    }
    const tokens = (n: unknown) =>
      typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
    let promptTokens = tokens(raw.usage?.input_tokens),
      completionTokens = tokens(raw.usage?.output_tokens);
    let choice = jevChoice(
      raw.answers?.next,
      selection.questions.next!.criteria,
    ).choice;
    const group = selection.groups.get(choice);
    if (group) choice = jevChoice(raw.answers?.[choice], group).choice;
    if (choice === 'NONE') choice = 'REPLAN';
    const finish = (
      decision: AgentDecision,
      extra?: DecisionOutput,
    ): DecisionOutput => ({
      decision,
      ...(extra?.workflow ? { workflow: extra.workflow } : {}),
      promptTokens: promptTokens + (extra?.promptTokens ?? 0),
      completionTokens: completionTokens + (extra?.completionTokens ?? 0),
    });
    if (choice === 'VISUAL_LOCATE' && picture && boxEnabled) {
      // 定位依赖前一轮已选视觉分支，额外请求独立计量，不能复用其他分组的局部概率。
      const visualBody = {
        ...payload,
        state: { ...payload.state, visualObjective: objective },
        questions: {
          exists: { type: 'noul', instructions: JEV_VISUAL_EXISTS },
          unique: {
            type: 'choice',
            instructions: JEV_VISUAL_UNIQUE,
            criteria: JEV_VISUAL_COUNTS,
          },
          target: { type: 'box', instructions: JEV_VISUAL_TARGET },
        },
      };
      const { assets: _assets, ...visualText } = visualBody;
      if (
        JSON.stringify(visualText).length > budget.requestChars ||
        estimatedTokens(visualText) + JEV_IMAGE_TOKEN_RESERVE > budget.tokens ||
        Buffer.byteLength(JSON.stringify(visualBody)) > JEV_REQUEST_BYTES
      ) {
        const output = await review('视觉定位问题超过 JEV 预算，交给文本审查');
        return finish(output.decision, output);
      }
      let located: Reply;
      try {
        located = await send(visualBody);
      } catch (error) {
        const reason = rejected(error);
        if (reason) {
          const output = await review(reason);
          return finish(output.decision, output);
        }
        throw error;
      }
      promptTokens += tokens(located.usage?.input_tokens);
      completionTokens += tokens(located.usage?.output_tokens);
      try {
        const point = jevBoxPoint(located.answers, picture, page);
        const mainFrame = page.documents?.find(
          (document) => document.isMainFrame,
        )?.frameId;
        const matched = page.targets.filter(
          (target) =>
            target.operations?.includes('click') &&
            (!target.frame || target.frame === mainFrame) &&
            target.clip &&
            point.x >= target.clip.left &&
            point.x < target.clip.right &&
            point.y >= target.clip.top &&
            point.y < target.clip.bottom,
        );
        // 图片只是定位辅助；可还原 DOM 身份时保留原有重访与节点命中检查。
        if (matched.length > 1)
          throw new AgentFault(
            'INVALID_MODEL_DECISION',
            '视觉位置对应多个 DOM 控件，需重新核对目标',
          );
        const target = matched[0];
        if (target) {
          if (readings.get(target.target)?.status === 'recorded')
            throw new AgentFault(
              'INVALID_MODEL_DECISION',
              '视觉目标已有读取证据，重访必须由文本模型说明原因',
            );
          if (
            context.executionStep?.type === 'verification' &&
            target.context?.fixed &&
            !target.context.heading &&
            !target.disclosure
          )
            throw new AgentFault(
              'INVALID_MODEL_DECISION',
              unassociatedTargetReview(target.target, target.name),
            );
          return finish({
            type: 'browser.act',
            action: 'click',
            target: target.target,
          });
        }
        return finish({
          type: 'browser.act',
          action: 'visual.click',
          ...point,
        });
      } catch (error) {
        if (!(error instanceof AgentFault)) throw error;
        const output = await review(error.message);
        return finish(output.decision, output);
      }
    }
    if (choice === 'VERIFY' || choice === 'REPLAN') {
      const output = await review(`JEV 建议 ${choice}`);
      return finish(output.decision, output);
    }
    const selectedAction = actions.get(choice);
    const operation = selectedAction?.operation ?? choice;
    if (operation === 'OBSERVE')
      return finish({ type: 'browser.observe', screenshot: false });
    if (
      ['SCROLL_DOWN', 'SCROLL_UP', 'SCROLL_LEFT', 'SCROLL_RIGHT'].includes(
        operation,
      )
    )
      return finish({
        type: 'browser.act',
        action: 'scroll',
        value: operation.slice('SCROLL_'.length).toLowerCase(),
        ...(selectedAction ? { target: selectedAction.target } : {}),
      });
    if (!selectedAction)
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '所选动作不属于当前候选集合',
      );
    const target = selectedAction.target;
    if (['CHECK', 'UNCHECK', 'FRAME', 'HOVER'].includes(operation))
      return finish({
        type: 'browser.act',
        action: operation.toLowerCase() as
          'check' | 'uncheck' | 'frame' | 'hover',
        target,
      });
    const observedTarget = page.targets.find((item) => item.target === target);
    // 保留全局控件候选，只把缺少正文关联的业务点击转交完整上下文审查。
    if (
      operation === 'CLICK' &&
      context.executionStep?.type === 'verification' &&
      observedTarget?.context?.fixed &&
      !observedTarget.context.heading &&
      !observedTarget.disclosure
    ) {
      const output = await review(
        unassociatedTargetReview(target, observedTarget.name),
      );
      return finish(output.decision, output);
    }
    if (operation === 'CLICK' && readings.get(target)?.status === 'recorded') {
      const output = await review(
        '所选子项已有读取证据；请选择未读取目标，视口未提供时先滚动。只有原任务要求重查或验证开关行为时才通过 workflow.revisitReason 说明重复操作原因',
      );
      return finish(output.decision, output);
    }
    if (operation === 'CLICK')
      return finish({ type: 'browser.act', action: 'click', target });
    if (operation === 'SELECT')
      return finish({
        type: 'browser.act',
        action: 'select',
        target,
        value: selectedAction!.value!,
      });
    const fieldBody = {
      // 字段生成沿用文本审查的模式配置；TypeSafe 候选请求保持独立协议。
      ...(this.config.thinking
        ? { thinking: { type: this.config.thinking } }
        : {}),
      model: this.config.model,
      [this.config.tokenParameter]: this.config.maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: FIELD_VALUE_PROMPT,
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: context.task,
            field: selectedAction!.field,
            page: page.text,
            recentOperations: context.recentOperations,
          }),
        },
      ],
    };
    const text = (await modelRequest(
      input,
      this.config.model,
      'FIELD_VALUE',
      fieldBody,
      () =>
        this.request(
          `${this.config.modelUrl}/chat/completions`,
          this.config.modelKey,
          'POST',
          fieldBody,
          this.config.modelMs,
          signal,
        ),
    )) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const pi = tokens(text.usage?.prompt_tokens),
      co = tokens(text.usage?.completion_tokens);
    let value: unknown;
    try {
      value = JSON.parse(text.choices?.[0]?.message?.content ?? '').text;
    } catch {
      value = undefined;
    }
    if (value === null) {
      // null 是字段协议允许的缺失信息结果；交回规划层，所有子请求仍计入原预算与用量。
      const output = await review(
        fieldValueRecovery(String(selectedAction!.field.name ?? '未命名字段')),
      );
      return finish(output.decision, {
        ...output,
        promptTokens: pi + (output.promptTokens ?? 0),
        completionTokens: co + (output.completionTokens ?? 0),
      });
    }
    if (typeof value !== 'string' || value.length > 8192)
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '无法从任务中生成所选字段的填写内容',
      );
    return {
      decision: { type: 'browser.act', action: 'fill', target, value },
      promptTokens: promptTokens + pi,
      completionTokens: completionTokens + co,
    };
  }
}
