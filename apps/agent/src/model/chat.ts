import { SYSTEM_PROMPT } from '../prompts/decision.js';
import {
  agentDecisionSchema,
  validateAgentDecision,
  type AgentDecision,
  type ModelCall,
  type ModelCallWrite,
} from '@proofrun/contracts';
import type { AgentConfig } from '../config.js';
import { AgentFault, jsonRequest } from '../http.js';
import { modelRequest } from './request.js';
import { WORKFLOW_SCHEMA, type WorkflowUpdate } from '../execution/workflow.js';

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
      name: type.const.replace('.', '_'),
      description: schema.description ?? type.const,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties,
        required: schema.required.filter((name) => name !== 'type'),
      },
    };
  },
) as Array<{
  type: AgentDecision['type'];
  name: string;
  description: string;
  parameters: object;
}>;

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
  /** 可选的一张当前截图，已经核实归属、格式与 SHA-256。 */
  image?: string;
}
/** 一次模型调用的结构化结果，token 数仅来自服务回复。 */
export interface DecisionOutput {
  decision: AgentDecision;
  /** 可选的证据进度与恢复计划，由公共执行器验证并保存。 */
  workflow?: WorkflowUpdate;
  promptTokens: number;
  completionTokens: number;
}
/** 执行循环只依赖此接口，供应商细节限制在单个适配器中。 */
export interface DecisionModel {
  decide(input: DecisionInput, signal: AbortSignal): Promise<DecisionOutput>;
}

/** 可配置 Chat Completions 适配器；一次 decide 恰好一次 HTTP 请求，无隐式重试。 */
export class ChatModel implements DecisionModel {
  constructor(private readonly config: AgentConfig) {}
  async decide(
    input: DecisionInput,
    signal: AbortSignal,
  ): Promise<DecisionOutput> {
    const hasWorkflow = !!JSON.parse(input.text).workflow;
    const content = input.image
      ? [
          { type: 'text', text: input.text },
          { type: 'image_url', image_url: { url: input.image } },
        ]
      : input.text;
    const body = {
      model: this.config.model,
      stream: false,
      parallel_tool_calls: false,
      [this.config.tokenParameter]: this.config.maxTokens,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
      tools: MODEL_TOOLS.map(({ name, parameters, description }) => ({
        type: 'function',
        function: {
          name,
          description,
          strict: false,
          parameters: hasWorkflow
            ? {
                ...parameters,
                properties: {
                  ...(parameters as { properties: object }).properties,
                  workflow: WORKFLOW_SCHEMA,
                },
              }
            : parameters,
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
          this.config.modelMs,
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
      choice?.message?.role !== 'assistant' ||
      !calls ||
      calls.length !== 1 ||
      calls[0]?.type !== 'function' ||
      !MODEL_TOOLS.some((tool) => tool.name === calls[0]?.function?.name) ||
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
    const tool = MODEL_TOOLS.find(
      (tool) => tool.name === calls[0]?.function?.name,
    )!;
    // 动作类型由已声明的工具名决定，参数中的同名字段也不能覆盖它。
    if ('type' in parsed)
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '工具参数不接受 type 字段，动作类型由工具名称决定',
      );
    const { workflow, ...args } = parsed as Record<string, unknown>;
    const decision = { ...args, type: tool.type };
    if (workflow !== undefined && !hasWorkflow)
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '当前执行未启用 workflow 元数据',
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
      promptTokens: tokens(raw.usage?.prompt_tokens),
      completionTokens: tokens(raw.usage?.completion_tokens),
    };
  }
}
