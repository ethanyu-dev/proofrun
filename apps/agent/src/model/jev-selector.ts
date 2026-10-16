import { requestContext } from './decision-view.js';
import {
  JEV_VISUAL_TARGET,
  JEV_VISUAL_EXISTS,
  JEV_VISUAL_UNIQUE,
  JEV_CONTROL_CHOICES,
  JEV_VISUAL_OPTION,
  JEV_VISUAL_COUNTS,
  unassociatedTargetReview,
} from '../prompts/jev.js';
import type { AgentDecision } from '@proofrun/contracts';
import { DEFAULT_JEV_MODEL, type AgentConfig } from '../config.js';
import { AgentFault, jsonRequest } from '../http.js';
import { modelRequest } from './request.js';
import { candidates, estimatedTokens, type Candidate } from './candidates.js';
import { evidenceExcerpt } from './evidence-excerpt.js';
import { jevQuestions, EXPANDED_ACTION_LIMIT } from './jev-questions.js';
import {
  prepareJevImage,
  JEV_IMAGE_TOKEN_RESERVE,
  JEV_REQUEST_BYTES,
  type JevImage,
} from './jev-image.js';
import { jevBoxPoint, supportsJevBox } from './jev-box.js';
import { decisionData, type DecisionInput } from './chat.js';

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
/** 已发生一次选择后，追加定位还需同时容纳失败复核与最终收尾。 */
const BOX_CALL_RESERVE = 3;

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

/** 候选选择不拥有规划或验收权限；字段缺值交给执行层统一路由。 */
export type JevSelection = (
  | { kind: 'action'; decision: AgentDecision }
  | {
      kind: 'review';
      reason: string;
      reasonCode: 'CHECKPOINT' | 'DECISION_GAP';
    }
  | { kind: 'field'; candidate: Candidate }
) & { promptTokens: number; completionTokens: number };

/** 仅保留供应商能力诊断，不保存页面历史、工作流、预算或模型复核状态。 */
export class JevSelector {
  /** 供应商拒绝图片后仅本 tab 停用该能力，避免重复失败请求。 */
  private imageRejection: string | undefined;
  constructor(
    /** 冻结的能力开关、请求时限与上下文上限。 */
    private readonly config: AgentConfig,
    /** 只发送给固定 TypeSafe 服务的凭据。 */
    private readonly key: string,
    /** 固定版本或显式模型名。 */
    private readonly model = DEFAULT_JEV_MODEL,
    /** 测试请求端口不改变生产端点。 */
    private readonly request: typeof jsonRequest = jsonRequest,
  ) {}
  /** 每个 tab 独立保存供应商图片能力诊断。 */
  fork() {
    return new JevSelector(this.config, this.key, this.model, this.request);
  }
  /** 输入来自同轮事实快照，输出必须再由公共执行器校验。 */
  async select(
    input: DecisionInput,
    signal: AbortSignal,
  ): Promise<JevSelection> {
    if (!this.key)
      throw new AgentFault('JEV_NOT_CONFIGURED', 'JEV 组缺少 TypeSafe 配置');
    const context = decisionData(input);
    const page = input.observation ?? context.observation;
    if (page.observationId !== context.observation.observationId)
      throw new AgentFault(
        'EVIDENCE_MISMATCH',
        '原始观察与模型上下文不属于同一轮',
      );
    const stage = context.workflow?.steps.find(
      (s) => s.id === context.workflow?.activeStep,
    );
    const recovery = context.plan ?? context.workflow?.recovery;
    const objective =
      (context.executionPolicy || context.executionGuidance) && recovery
        ? recovery.goal
        : (stage?.requirement ?? context.task.objective);
    const isCollected = (status: string | undefined) =>
      status === 'recorded' ||
      (context.executionPolicy?.version === 'planned-v1' &&
        recovery?.collectReadings === true &&
        status === 'observed');
    const review = (
      reason: string,
      reasonCode: 'CHECKPOINT' | 'DECISION_GAP' = 'DECISION_GAP',
    ): JevSelection => ({
      kind: 'review',
      reason,
      reasonCode,
      promptTokens: 0,
      completionTokens: 0,
    });
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
        if (!recovery?.allowedActions) return true;
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
          !isCollected(readings.get(candidate.target)?.status),
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
      recovery?.allowedActions &&
      !recovery.allowedActions.includes('scroll')
    ) {
      delete controls.SCROLL_UP;
      delete controls.SCROLL_DOWN;
    }
    if (
      boxEnabled &&
      (!recovery?.allowedActions ||
        recovery.allowedActions.includes('visual.click'))
    )
      controls.VISUAL_LOCATE = JEV_VISUAL_OPTION;
    const actions = new Map<string, Candidate>();
    for (const candidate of selected) {
      const id = `A${actions.size + 1}`;
      actions.set(id, candidate);
    }
    let selection = jevQuestions(actions, controls, expanded);
    const compactHistory = (context.previousObservations ?? []).map((p) => ({
      ...p,
      text: evidenceExcerpt(p.text, objective, 2000),
      truncated: p.truncated || p.text.length > 2000,
    }));
    const budget = this.config.jevLongContext ? LONG_CONTEXT : DEFAULT_CONTEXT;
    const compactText = evidenceExcerpt(page.text, objective, budget.pageChars);
    const body = {
      model: this.model,
      state: {
        ...requestContext(context),
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
    const started = performance.now();
    let sent = 0;
    const send = async (
      requestBody: Record<string, unknown>,
    ): Promise<Reply> => {
      signal.throwIfAborted();
      if (context.executionPolicy) {
        requestBody = {
          ...requestBody,
          state: {
            ...(requestBody.state as Record<string, unknown>),
            budgetRemaining: {
              ...context.budgetRemaining,
              modelCalls: Math.max(
                0,
                context.budgetRemaining.modelCalls - sent,
              ),
              timeMs: Math.max(
                0,
                Math.floor(
                  context.budgetRemaining.timeMs -
                    (performance.now() - started),
                ),
              ),
            },
          },
        };
      }
      sent++;
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
            Math.min(
              this.config.modelMs,
              input.modelDeadline === undefined
                ? Infinity
                : Math.max(1, input.modelDeadline - performance.now()),
            ),
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
    const addUsage = (result: JevSelection): JevSelection => ({
      ...result,
      promptTokens: promptTokens + result.promptTokens,
      completionTokens: completionTokens + result.completionTokens,
    });
    const finish = (decision: AgentDecision): JevSelection =>
      addUsage({
        kind: 'action',
        decision,
        promptTokens: 0,
        completionTokens: 0,
      });
    if (choice === 'VISUAL_LOCATE' && picture && boxEnabled) {
      if (
        context.executionPolicy &&
        context.budgetRemaining.modelCalls <= BOX_CALL_RESERVE
      )
        return addUsage(
          review('剩余调用只够文本复核和收尾，停止额外视觉定位请求'),
        );
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
        const output = review('视觉定位问题超过 JEV 预算，交给文本审查');
        return addUsage(output);
      }
      let located: Reply;
      try {
        located = await send(visualBody);
      } catch (error) {
        const reason = rejected(error);
        if (reason) {
          const output = review(reason);
          return addUsage(output);
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
          if (isCollected(readings.get(target.target)?.status))
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
        const output = review(error.message);
        return addUsage(output);
      }
    }
    if (choice === 'VERIFY' || choice === 'REPLAN') {
      const output = review(
        `JEV 建议 ${choice}`,
        choice === 'VERIFY' ? 'CHECKPOINT' : 'DECISION_GAP',
      );
      return addUsage(output);
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
      const output = review(
        unassociatedTargetReview(target, observedTarget.name),
      );
      return addUsage(output);
    }
    if (operation === 'CLICK' && isCollected(readings.get(target)?.status)) {
      const output = review(
        '所选子项已有读取证据；请选择未读取目标，视口未提供时先滚动。只有原任务要求重查或验证开关行为时才通过 workflow.revisitReason 说明重复操作原因',
      );
      return addUsage(output);
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
    return addUsage({
      kind: 'field',
      candidate: selectedAction,
      promptTokens: 0,
      completionTokens: 0,
    });
  }
}
