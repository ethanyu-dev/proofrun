import {
  FIELD_VALUE_PROMPT,
  FIELD_RESULT_REVIEW,
  fieldValueRecovery,
  reviewFeedback,
  FINAL_REVIEW_REASON,
  ACTIONS_EXHAUSTED_REASON,
} from '../prompts/jev.js';
import { DEFAULT_JEV_MODEL, type AgentConfig } from '../config.js';
import { reasoningParameters } from './reasoning.js';
import { AgentFault, jsonRequest } from '../http.js';
import { modelRequest } from './request.js';
import { JevProgress } from './jev-progress.js';
import { JevSelector } from './jev-selector.js';
export { jevChoice } from './jev-selector.js';
import {
  ChatModel,
  type DecisionInput,
  type DecisionModel,
  type DecisionOutput,
} from './chat.js';

/** 每个执行独立实例，所有动作仍由原执行器、控制面与节点校验。 */
export class JevModel implements DecisionModel {
  /** 与对照组使用同一配置，负责自由文本和按证据验收。 */
  private readonly text: DecisionModel;
  /** 图片参数被供应商拒绝后，本次执行不重复发送同类图片请求。 */
  private readonly selector: JevSelector;
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
    this.selector = new JevSelector(config, key, model, request);
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
    const { context: _context, ...selectionInput } = input;
    const selected = await this.selector.select(
      { ...selectionInput, text: JSON.stringify(enriched) },
      signal,
    );
    const finish = (output: DecisionOutput): DecisionOutput => ({
      ...output,
      promptTokens: selected.promptTokens + output.promptTokens,
      completionTokens: selected.completionTokens + output.completionTokens,
    });
    if (selected.kind === 'action')
      return finish({
        decision: selected.decision,
        promptTokens: 0,
        completionTokens: 0,
      });
    if (selected.kind === 'review')
      return finish(await review(selected.reason));
    const selectedAction = selected.candidate;
    const target = selectedAction.target;
    const promptTokens = selected.promptTokens,
      completionTokens = selected.completionTokens;
    const tokens = (n: unknown) =>
      typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
    const fieldBody = {
      // 字段生成沿用文本审查的模式配置；TypeSafe 候选请求保持独立协议。
      ...reasoningParameters(this.config),
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
      return finish({
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
