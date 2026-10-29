import { decisionTools, type DecisionTool } from './tools.js';
import { decisionPrompt } from '../prompts/decision.js';
import {
  agentDecisionSchema,
  validateAgentDecision,
  type AgentDecision,
  type VerificationReport,
} from '@proofrun/contracts';
import type { AgentConfig } from '../config.js';
import { AgentFault, jsonRequest } from '../http.js';
import { modelTransport } from './transport.js';
import { modelRequest } from './request.js';
import { reasoningParameters, toolChoice } from './reasoning.js';
import { isModelToolCall, networkBatch } from './network-batch.js';

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

export type {
  DecisionInput,
  DecisionOutput,
  DecisionModel,
} from '@proofrun/execution-core/model';
import {
  decisionData,
  type DecisionInput,
  type DecisionOutput,
  type DecisionModel,
} from '@proofrun/execution-core/model';
/** 可配置 Chat Completions 适配器；一次 decide 恰好一次 HTTP 请求，无隐式重试。 */
export class ChatModel implements DecisionModel {
  constructor(private readonly config: AgentConfig) {}
  async decide(
    input: DecisionInput,
    signal: AbortSignal,
  ): Promise<DecisionOutput> {
    const context = decisionData(input);
    const text = JSON.stringify(context);
    const availableTools = decisionTools(
      context,
      MODEL_TOOLS,
      this.config.vision && !!input.image,
    );
    const content =
      this.config.vision && input.image
        ? [
            { type: 'text', text },
            { type: 'image_url', image_url: { url: input.image } },
          ]
        : text;
    const body = {
      ...reasoningParameters(this.config),
      model: this.config.model,
      stream: false,
      parallel_tool_calls: false,
      [this.config.tokenParameter]: this.config.maxTokens,
      messages: [
        {
          role: 'system',
          content: decisionPrompt(context, availableTools),
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
      tool_choice: toolChoice(this.config),
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
          undefined,
          modelTransport,
        ),
    )) as {
      choices?: Array<{
        finish_reason?: string;
        message?: {
          role?: string;
          tool_calls?: unknown;
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
    const rawCalls = choice?.message?.tool_calls;
    const calls: unknown[] | undefined = Array.isArray(rawCalls)
      ? rawCalls
      : undefined;
    const firstCall = calls?.[0];
    if (
      calls?.length === 1 &&
      isModelToolCall(firstCall) &&
      firstCall.function.name === 'verification_intervene' &&
      !context.task.permissions.allowIntervention
    )
      throw new AgentFault('INTERVENTION_DISABLED', '当前任务未授权人工介入');
    if (
      calls?.length === 1 &&
      isModelToolCall(firstCall) &&
      firstCall.function.name === 'browser_act' &&
      context.budget?.actions === 0
    )
      throw new AgentFault(
        context.task.stepId
          ? 'STEP_ACTION_BUDGET_EXCEEDED'
          : 'ACTION_BUDGET_EXCEEDED',
        '动作预算已耗尽，只能保存已有证据或明确阻塞，不能继续浏览器动作',
      );
    if (
      calls?.length === 1 &&
      isModelToolCall(firstCall) &&
      firstCall.function.name === 'browser_observe' &&
      !availableTools.some((tool) => tool.type === 'browser.observe')
    )
      throw new AgentFault(
        'OBSERVATION_STALLED',
        '页面连续观察没有新增事实，当前应登记已有验收结果、执行实际动作或明确受阻，不能继续重复 observe。',
      );
    if (
      choice?.message?.role === 'assistant' &&
      choice.finish_reason !== 'length' &&
      calls &&
      calls.length > 1
    ) {
      const [decision, ...additionalNetworkReads] = networkBatch(
        calls,
        availableTools,
      );
      return {
        decision: decision!,
        additionalNetworkReads,
        promptTokens: tokens(raw.usage?.prompt_tokens),
        completionTokens: tokens(raw.usage?.completion_tokens),
      };
    }
    if (
      choice?.message?.role !== 'assistant' ||
      !calls ||
      calls.length !== 1 ||
      !isModelToolCall(firstCall) ||
      !availableTools.some((tool) => tool.name === firstCall.function.name) ||
      choice.finish_reason === 'length'
    )
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '模型必须返回一个完整的已声明工具调用',
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(firstCall.function.arguments);
    } catch {
      throw new AgentFault('INVALID_MODEL_DECISION', '模型工具参数不是 JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '工具参数必须是 JSON 对象',
      );
    const tool = availableTools.find(
      (tool) => tool.name === firstCall.function.name,
    )!;
    // 动作类型由已声明的工具名决定，参数中的同名字段也不能覆盖它。
    if ('type' in parsed)
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '工具参数不接受 type 字段，动作类型由工具名称决定',
      );
    const { progress, revisitReason, ...args } = parsed as Record<
      string,
      unknown
    >;
    if (
      ['plan', 'workflow', 'conclusions', 'criteria'].some((key) => key in args)
    )
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '进度只接受 progress，不接受旧计划或重复结论入口',
      );
    const object = (value: unknown): value is Record<string, unknown> =>
      !!value && typeof value === 'object' && !Array.isArray(value);
    if (
      progress !== undefined &&
      (!object(progress) ||
        Object.keys(progress).some(
          (key) => !['requirements', 'criteria', 'readings'].includes(key),
        ))
    )
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        'progress 只接受 requirements、criteria 和 readings',
      );
    const saved = progress as Record<string, unknown> | undefined;
    if (saved && Object.values(saved).some((value) => !Array.isArray(value)))
      throw new AgentFault('INVALID_MODEL_DECISION', 'progress 各项必须是数组');
    const conclusions = saved?.criteria as
      VerificationReport['criteria'] | undefined;
    // setup 误填 stepId 时优先给出任务语义反馈，避免模型反复修补无关证据字段。
    if (
      tool.type === 'verification.finish' &&
      context.task?.criteria?.length === 0 &&
      Array.isArray(conclusions) &&
      conclusions.length
    )
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '当前 setup 没有独立验收项，progress.criteria 必须为空；stepId 不是 criterionId。用 summary 和本步 evidenceRefs 提交执行结果。',
      );
    if (
      conclusions?.length &&
      !validateAgentDecision({
        type: 'verification.record',
        summary: '保存当前证据结论',
        progress: { criteria: conclusions },
      })
    )
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        'progress.criteria 不符合验收协议',
      );
    if (
      revisitReason !== undefined &&
      (tool.type !== 'browser.act' ||
        typeof revisitReason !== 'string' ||
        !revisitReason.trim() ||
        revisitReason.length > 600)
    )
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '重访原因只能随浏览器动作提交',
      );
    if (
      tool.type === 'verification.record' &&
      !Object.values(saved ?? {}).some(
        (value) => Array.isArray(value) && value.length,
      )
    )
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        'record 必须提供可保存的 progress',
      );
    const decision = {
      ...args,
      type: tool.type,
      ...(progress !== undefined ? { progress } : {}),
      ...(revisitReason !== undefined ? { revisitReason } : {}),
    };
    if (
      decision.type === 'browser.act' &&
      args.action === 'visual.click' &&
      (!this.config.vision || !input.image)
    )
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '文本模型未收到当前截图，不能执行视觉点击',
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
      if (Array.isArray(conclusions) && conclusions.length) {
        return {
          decision: {
            type: 'verification.record',
            summary: `本轮动作参数无效，未执行；仅保存已提交的独立结论。${issues}`,
            progress: { criteria: conclusions },
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
      promptTokens: tokens(raw.usage?.prompt_tokens),
      completionTokens: tokens(raw.usage?.completion_tokens),
    };
  }
}
