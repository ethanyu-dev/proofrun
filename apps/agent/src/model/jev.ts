import {
  FIELD_VALUE_PROMPT,
  JEV_SELECTION_RULES,
  reviewFeedback,
} from '../prompts/jev.js';
import type { AgentDecision } from '@proofrun/contracts';
import type { AgentConfig } from '../config.js';
import type { WorkflowView } from '../execution/workflow.js';
import type { Observation } from '../evidence/observation.js';
import { AgentFault, jsonRequest } from '../http.js';
import { modelRequest } from './request.js';
import { candidates, estimatedTokens, type Candidate } from './candidates.js';
import { JevProgress, evidenceExcerpt } from './jev-progress.js';
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
/** 字符限额只是传输保护，单问题 token 预算另外保守估计并预留模型开销。 */
const JEV_REQUEST_CHARS = 64000;
const JEV_TOKEN_BUDGET = 28000;
const JEV_PAGE_CHARS = 14000;

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
  /** 跨栏目证据及循环检测只在当前执行内生效。 */
  private readonly progress = new JevProgress();
  /** 公共执行器确认有新的步骤证据后，才清除局部循环计数。 */
  private revision = 0;
  /** 结构化步骤身份只能由执行器推进，切换后允许重新访问相同业务页面。 */
  private structuredStep: string | undefined;
  constructor(
    /** 共用超时与文本模型设置。 */
    private readonly config: AgentConfig,
    /** 仅发往固定 TypeSafe 端点的服务凭据。 */
    private readonly key: string,
    /** TypeSafe 模型名，报告按真实请求分别计数。 */
    private readonly model = 'jev-latest',
    /** 测试可注入请求端口；生产固定使用 TypeSafe 地址。 */
    private readonly request: typeof jsonRequest = jsonRequest,
    /** 测试替换审查器，不影响生产模型配置。 */
    reviewer?: DecisionModel,
  ) {
    this.text = reviewer ?? new ChatModel(config);
  }
  /** 将当前页面转换为有限候选；输出仍遵守原执行器的动作协议。 */
  async decide(
    input: DecisionInput,
    signal: AbortSignal,
  ): Promise<DecisionOutput> {
    if (!this.key)
      throw new AgentFault('JEV_NOT_CONFIGURED', 'JEV 组缺少 TypeSafe 配置');
    const context = JSON.parse(input.text) as {
      task: { taskId: string; objective: string };
      observation: Observation;
      recentOperations: unknown[];
      budgetRemaining: { actions: number };
      feedback: unknown;
      workflow?: WorkflowView;
      executionStep?: { stepId: string };
    };
    if (
      context.executionStep &&
      context.executionStep.stepId !== this.structuredStep
    ) {
      this.progress.advanced();
      this.structuredStep = context.executionStep.stepId;
    }
    const page = context.observation;
    const stage = context.workflow?.steps.find(
      (s) => s.id === context.workflow?.activeStep,
    );
    const objective = stage?.requirement ?? context.task.objective;
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
      const output = await this.text.decide(
        {
          ...input,
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
    const reason =
      typeof context.feedback === 'string' &&
      /^(WORKFLOW_|BROWSER_TARGET_OBSCURED:|BROWSER_STALE_OBSERVATION:)/u.test(
        context.feedback,
      )
        ? '执行器反馈步骤缺口、预算耗尽或动作目标失效；请核对当前状态并改变恢复策略，无法继续时 verification.block'
        : context.workflow?.activeStep === null
          ? '全部原始步骤已登记证据，请按原 criterionId 整理最终结论，避免继续浏览'
          : recovery?.remaining === 0
            ? '恢复计划动作预算耗尽，核对成功条件；未成功时改变策略或停止，不能重复同一计划'
            : this.progress.reviewReason(
                context.budgetRemaining.actions,
                !!recovery && recovery.remaining > 0,
              );
    if (reason) return review(reason);
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
    );
    const selected = available.slice(0, ACTION_LIMIT);
    // 变化排序后的动作共享一份简短字段说明，不重复完整 DOM 行。
    const choices: Record<string, unknown> = {
      OBSERVE: '加载尚未完成，重新读取页面',
      SCROLL_DOWN: '页面向下滚动；弹层或下拉应优先选择带目标的滚动候选',
      SCROLL_UP: '页面向上滚动查看未检查内容',
      VERIFY:
        '当前阶段证据已齐，交给 LLM 记录进度并推进；全部原任务步骤完成后才最终验收',
      REPLAN:
        '目标未提供、覆盖不全、需要复杂规划或重复操作无进展，交给 LLM 检查',
    };
    const actions = new Map<string, Candidate>();
    for (const candidate of selected) {
      const id = `A${actions.size + 1}`;
      actions.set(id, candidate);
      choices[id] = { operation: candidate.operation, field: candidate.field };
    }
    const questions = {
      next: {
        type: 'choice',
        criteria: choices,
        instructions: {
          rules: JEV_SELECTION_RULES,
        },
      },
    };
    const compactHistory = history.map((p) => ({
      ...p,
      text: evidenceExcerpt(p.text, objective, 2000),
      truncated: p.truncated || p.text.length > 2000,
    }));
    const compactText = evidenceExcerpt(page.text, objective, JEV_PAGE_CHARS);
    const body = {
      model: this.model,
      state: {
        ...enriched,
        previousObservations: compactHistory,
        observation: {
          ...page,
          text: compactText,
          textTruncated: compactText !== page.text,
          targets: undefined,
        },
        omittedTargets:
          new Set(available.map((a) => a.target)).size -
          new Set(selected.map((a) => a.target)).size,
        candidateCoverage: {
          totalActions: available.length,
          returnedActions: selected.length,
          omittedActions: available.length - selected.length,
          reason: available.length > selected.length ? 'action_limit' : null,
        },
      },
      questions,
    };
    while (
      compactHistory.length &&
      (JSON.stringify(body).length > JEV_REQUEST_CHARS ||
        estimatedTokens(body) > JEV_TOKEN_BUDGET)
    )
      compactHistory.shift();
    // 先移除低优先级候选，再转交审查；新增弹层候选排在前面，不因页尾位置被裁剪。
    while (
      (JSON.stringify(body).length > JEV_REQUEST_CHARS ||
        estimatedTokens(body) > JEV_TOKEN_BUDGET) &&
      actions.size > 1
    ) {
      const last = [...actions.keys()].at(-1)!;
      actions.delete(last);
      delete choices[last];
      body.state.candidateCoverage.returnedActions = actions.size;
      body.state.candidateCoverage.omittedActions =
        available.length - actions.size;
      body.state.candidateCoverage.reason = 'context_budget';
      body.state.omittedTargets =
        new Set(available.map((a) => a.target)).size -
        new Set([...actions.values()].map((a) => a.target)).size;
    }
    if (
      JSON.stringify(body).length > JEV_REQUEST_CHARS ||
      estimatedTokens(body) > JEV_TOKEN_BUDGET
    )
      return review(
        '当前页面候选与任务定义超过 JEV 请求预算，使用完整上下文核对下一步',
      );
    let raw: {
      answers?: Record<string, unknown>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    try {
      raw = (await modelRequest(input, this.model, 'JEV_SELECTION', body, () =>
        this.request(
          ENDPOINT,
          this.key,
          'POST',
          body,
          this.config.modelMs,
          signal,
        ),
      )) as typeof raw;
    } catch (error) {
      if (
        error instanceof AgentFault &&
        error.code === 'MODEL_CONTEXT_TOO_LARGE'
      )
        return review('JEV 服务拒绝上下文长度，转交文本模型核对完整证据');
      throw error;
    }
    const tokens = (n: unknown) =>
      typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
    const promptTokens = tokens(raw.usage?.input_tokens),
      completionTokens = tokens(raw.usage?.output_tokens);
    const choice = jevChoice(raw.answers?.next, choices).choice;
    const finish = (
      decision: AgentDecision,
      extra?: DecisionOutput,
    ): DecisionOutput => ({
      decision,
      ...(extra?.workflow ? { workflow: extra.workflow } : {}),
      promptTokens: promptTokens + (extra?.promptTokens ?? 0),
      completionTokens: completionTokens + (extra?.completionTokens ?? 0),
    });
    if (choice === 'VERIFY' || choice === 'REPLAN') {
      const output = await review(`JEV 建议 ${choice}`);
      return finish(output.decision, output);
    }
    const selectedAction = actions.get(choice);
    const operation = selectedAction?.operation ?? choice;
    if (operation === 'OBSERVE')
      return finish({ type: 'browser.observe', screenshot: false });
    if (operation === 'SCROLL_DOWN' || operation === 'SCROLL_UP')
      return finish({
        type: 'browser.act',
        action: 'scroll',
        value: operation === 'SCROLL_DOWN' ? 'down' : 'up',
        ...(selectedAction ? { target: selectedAction.target } : {}),
      });
    const target = selectedAction!.target;
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
      value = null;
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
