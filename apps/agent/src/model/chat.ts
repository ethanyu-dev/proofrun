import type { DecisionContextData } from '../execution/context.js';
import { decisionTools, type DecisionTool } from './tools.js';
import { compactDecisionText } from './decision-view.js';
import { CONCLUSION_RULES, SETTLEMENT_RULES } from '../prompts/settlement.js';
import { SYSTEM_PROMPT } from '../prompts/decision.js';
import {
  agentDecisionSchema,
  validateAgentDecision,
  type AgentDecision,
  type ModelCall,
  type ModelCallWrite,
  type VerificationReport,
} from '@proofrun/contracts';
import type { AgentConfig } from '../config.js';
import { AgentFault, jsonRequest } from '../http.js';
import { modelRequest } from './request.js';
import type { WorkflowUpdate } from '../execution/workflow.js';
import type { Observation } from '../evidence/observation.js';

/** 将封闭协议的各分支映射成独立工具，避免供应商遗漏嵌套联合对象的外层字段。 */
const MODEL_TOOLS = agentDecisionSchema.oneOf.map(
  (schema: {
    properties: Record<string, unknown> & { type: { const: string } };
    required: string[];
    description?: string;
  }) => {
    const { type, ...properties } = schema.properties;
    return {
      type: type.const,
      name: type.const.replaceAll('.', '_'),
      description: schema.description ?? type.const,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties,
        required: schema.required.filter((name) => name !== 'type'),
      },
    };
  },
) as DecisionTool[];

/** 模型上下文由执行器根据事实重建，不保存不断增长的聊天历史。 */
export interface DecisionInput {
  /** 正文在实际请求前保存，返回的回执函数补交该次供应商回复或稳定错误码。 */
  traceRequest?: (
    request: Pick<
      ModelCall,
      'model' | 'purpose' | 'request' | 'requestSha256' | 'imagesOmitted'
    >,
  ) => Promise<
    (
      result: Extract<ModelCallWrite, { phase: 'finish' }>['result'],
    ) => Promise<void>
  >;
  /** 每次真实 HTTP 模型请求前扣预算；混合策略的子请求也必须登记。 */
  recordRequest?: (model: string) => void;
  /** 只登记服务实际返回的用量，异常或缺失 usage 不推算。 */
  recordUsage?: (model: string, input: number, output: number) => void;
  /** 有界 JSON 文本，包括固定标准、最新观察、近期操作与可引用证据。 */
  text: string;
  /** 本轮模型派发的单调时钟截止点，不能占用原预算内预留的收尾时间。 */
  modelDeadline?: number;
  /** 同一裁剪快照的类型化副本；旧调用端只提供 text 时仍兼容。 */
  context?: DecisionContextData;
  /** 可选的一张当前截图，已经核实归属、格式与 SHA-256。 */
  image?: string;
  /** 执行器保留的原始观察副本，供专用适配器独立裁剪；不直接发送给文本模型。 */
  observation?: Observation;
}
/** 一次模型调用的结构化结果，token 数仅来自服务回复。 */
export interface DecisionOutput {
  decision: AgentDecision;
  /** 可选的证据进度与恢复计划，由公共执行器验证并保存。 */
  workflow?: WorkflowUpdate;
  /** 仅引用本轮动作前已有证据，公共执行器先保存再执行下一动作。 */
  conclusions?: VerificationReport['criteria'];
  promptTokens: number;
  completionTokens: number;
}
/** 执行循环只依赖此接口，供应商细节限制在单个适配器中。 */
export interface DecisionModel {
  /** 有跨轮状态的适配器必须为每个 tab 创建独立实例；无状态适配器可直接复用。 */
  fork?(): DecisionModel;
  decide(input: DecisionInput, signal: AbortSignal): Promise<DecisionOutput>;
}

/** 可配置 Chat Completions 适配器；一次 decide 恰好一次 HTTP 请求，无隐式重试。 */
export class ChatModel implements DecisionModel {
  constructor(private readonly config: AgentConfig) {}
  async decide(
    input: DecisionInput,
    signal: AbortSignal,
  ): Promise<DecisionOutput> {
    const text = compactDecisionText(input.text);
    const availableTools = decisionTools(text, MODEL_TOOLS);
    const context = JSON.parse(input.text);
    const hasWorkflow = !!context.workflow;
    const content =
      this.config.vision && input.image
        ? [
            { type: 'text', text },
            { type: 'image_url', image_url: { url: input.image } },
          ]
        : text;
    // JEV 独立启用图片时，文本审查仍不得获得自己不支持的视觉点击工具。
    if (!this.config.vision || !input.image) {
      const act = availableTools.find((tool) => tool.type === 'browser.act');
      if (act) {
        const schema = act.parameters as {
          properties: { action: { enum: string[] } };
        };
        schema.properties.action.enum = schema.properties.action.enum.filter(
          (action) => action !== 'visual.click',
        );
      }
    }
    const body = {
      // 不向其他供应商默认添加扩展参数；DeepSeek 强制工具调用需显式关闭思考模式。
      ...(this.config.thinking
        ? { thinking: { type: this.config.thinking } }
        : {}),
      model: this.config.model,
      stream: false,
      parallel_tool_calls: false,
      [this.config.tokenParameter]: this.config.maxTokens,
      messages: [
        {
          role: 'system',
          content:
            context.verificationReview?.reason === 'budget'
              ? SETTLEMENT_RULES
              : SYSTEM_PROMPT +
                (context.executionGuidance ? '\n' + CONCLUSION_RULES : ''),
        },
        { role: 'user', content },
      ],
      tools: availableTools.map(({ name, parameters, description }) => ({
        type: 'function',
        function: {
          name,
          description,
          strict: false,
          parameters,
        },
      })),
      tool_choice: 'required',
    };
    const raw = (await modelRequest(
      input,
      this.config.model,
      'DECISION',
      body,
      () =>
        jsonRequest(
          `${this.config.modelUrl}/chat/completions`,
          this.config.modelKey,
          'POST',
          body,
          Math.min(
            this.config.modelMs,
            input.modelDeadline === undefined
              ? Infinity
              : Math.max(1, input.modelDeadline - performance.now()),
          ),
          signal,
        ),
    )) as {
      choices?: Array<{
        finish_reason?: string;
        message?: {
          role?: string;
          tool_calls?: Array<{
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    // 用量属于已完成的供应商请求，必须在工具解析与校验前登记，失败回复也不能漏计。
    const tokens = (value: unknown) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : 0;
    const choice = raw?.choices?.[0];
    const calls = choice?.message?.tool_calls;
    if (
      calls?.length === 1 &&
      calls[0]?.function?.name === 'browser_act' &&
      context.budgetRemaining?.actions === 0
    )
      throw new AgentFault(
        context.executionStep
          ? 'STEP_ACTION_BUDGET_EXCEEDED'
          : 'ACTION_BUDGET_EXCEEDED',
        '动作预算已耗尽，只能保存已有证据或明确阻塞，不能继续浏览器动作',
      );
    if (
      calls?.length === 1 &&
      calls[0]?.function?.name === 'browser_observe' &&
      !availableTools.some((tool) => tool.type === 'browser.observe')
    )
      throw new AgentFault(
        'OBSERVATION_STALLED',
        '页面连续观察没有新增事实，当前应登记已有验收结果、执行实际动作或明确受阻，不能继续重复 observe。',
      );
    if (
      choice?.message?.role !== 'assistant' ||
      !calls ||
      calls.length !== 1 ||
      calls[0]?.type !== 'function' ||
      !availableTools.some((tool) => tool.name === calls[0]?.function?.name) ||
      choice.finish_reason === 'length'
    )
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '模型必须返回一个完整的已声明工具调用',
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(calls[0].function?.arguments ?? '');
    } catch {
      throw new AgentFault('INVALID_MODEL_DECISION', '模型工具参数不是 JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '工具参数必须是 JSON 对象',
      );
    const tool = availableTools.find(
      (tool) => tool.name === calls[0]?.function?.name,
    )!;
    // 动作类型由已声明的工具名决定，参数中的同名字段也不能覆盖它。
    if ('type' in parsed)
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '工具参数不接受 type 字段，动作类型由工具名称决定',
      );
    let { workflow, conclusions, ...args } = parsed as Record<string, unknown>;
    // 完成工具的裸声明数组与 assessments 容器语义唯一；只补容器，条目仍由公共工作流严格校验。
    if (
      context.executionGuidance &&
      tool.type === 'verification.finish' &&
      Array.isArray(workflow)
    )
      workflow = { assessments: workflow };
    // 部分模型把证据元数据放入已有 workflow 容器；只兼容明确的同名字段，不猜测其他未知结构。
    if (
      workflow &&
      typeof workflow === 'object' &&
      !Array.isArray(workflow) &&
      'conclusions' in workflow
    ) {
      if (conclusions !== undefined)
        throw new AgentFault(
          'INVALID_MODEL_DECISION',
          'conclusions 只能声明一份，不能同时出现在工具顶层和 workflow 中',
        );
      const { conclusions: nested, ...progress } = workflow as Record<
        string,
        unknown
      >;
      conclusions = nested;
      workflow = Object.keys(progress).length ? progress : undefined;
    }
    if (
      conclusions !== undefined &&
      (!context.executionGuidance ||
        context.executionStep?.type === 'setup' ||
        context.cleanup ||
        !(
          Array.isArray(conclusions) &&
          (conclusions.length === 0 ||
            validateAgentDecision({
              type: 'verification.record',
              summary: '随本轮决定保存已有证据结论',
              criteria: conclusions,
            }))
        ))
    )
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        'conclusions 必须是当前业务步骤的合法验收结论数组',
      );
    const decision = { ...args, type: tool.type };
    if (
      decision.type === 'browser.act' &&
      args.action === 'visual.click' &&
      (!this.config.vision || !input.image)
    )
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '文本模型未收到当前截图，不能执行视觉点击',
      );
    if (workflow !== undefined && !hasWorkflow)
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '当前执行未启用 workflow 元数据',
      );
    // setup 误填 stepId 时优先给出任务语义反馈，避免模型反复修补无关证据字段。
    if (
      decision.type === 'verification.finish' &&
      context.task?.acceptanceCriteria?.length === 0 &&
      Array.isArray(args.criteria) &&
      args.criteria.length
    )
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '当前 setup 没有独立验收项，criteria 必须是 []；stepId 不是 criterionId。用 summary 和本步 evidenceRefs 提交执行结果。',
      );
    if (!validateAgentDecision(decision)) {
      // 只反馈匹配分支的静态约束，不回显模型内容、未知字段名或整份原始回复。
      const branch = agentDecisionSchema.oneOf.findIndex(
        (schema: { properties: { type: { const: string } } }) =>
          schema.properties.type.const === decision?.type,
      );
      const issues = (validateAgentDecision.errors ?? [])
        .filter((error) =>
          branch < 0
            ? error.keyword === 'oneOf'
            : error.schemaPath.startsWith(`#/oneOf/${branch}/`),
        )
        .slice(0, 6)
        .map((error) => `${error.schemaPath}: ${error.message}`)
        .join('; ');
      // 已有结论与下一动作分别校验：动作参数无效时只保存合法结论，绝不派发或修补该动作。
      if (
        Array.isArray(conclusions) &&
        conclusions.length &&
        context.executionGuidance
      ) {
        return {
          decision: {
            type: 'verification.record',
            summary: `本轮动作参数无效，未执行；仅保存已提交的独立结论。${issues}`,
            criteria: conclusions as Extract<
              AgentDecision,
              { type: 'verification.record' }
            >['criteria'],
          },
          promptTokens: tokens(raw.usage?.prompt_tokens),
          completionTokens: tokens(raw.usage?.completion_tokens),
        };
      }
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        `模型决定不满足封闭工具协议：${issues}。请按所调用工具的 schema 修正，省略无关字段。`,
      );
    }
    return {
      decision,
      ...(workflow !== undefined
        ? { workflow: workflow as WorkflowUpdate }
        : {}),
      ...(conclusions !== undefined
        ? { conclusions: conclusions as VerificationReport['criteria'] }
        : {}),
      promptTokens: tokens(raw.usage?.prompt_tokens),
      completionTokens: tokens(raw.usage?.completion_tokens),
    };
  }
}
