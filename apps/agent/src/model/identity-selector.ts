import type { AgentConfig } from '../config.js';
import { AgentFault, jsonRequest } from '../http.js';
import { IDENTITY_SELECTOR_PROMPT } from '../prompts/identity-selector.js';

/** 输入只包含原始要求和目录摘要，不接收浏览器状态或凭据。 */
export interface IdentitySelectionInput {
  /** 待选择任务引用，仅用于回写，不发送给模型。 */
  taskId: string;
  /** 短期选择租约凭据，仅用于控制面认证。 */
  token: string;
  /** 原始测试目标与步骤，不含浏览器状态。 */
  task: { objective: string; url: string; steps?: unknown[] };
  /** 经过同源筛选的冻结元数据，只有内部候选引用可被选择。 */
  candidates: Array<{
    id: string;
    name: string;
    type: string;
    description: string;
    url: string;
  }>;
}
/** 身份选择失败也是明确的人工分支，不把无效输出当作选中第一个账号。 */
export interface IdentityChoice {
  /** 选择的候选；为空时按 needsIdentity 区分公开页面和人工准备。 */
  identityId: string | null;
  /** 是否需要有身份的会话，不代表当前账号已验证有效。 */
  needsIdentity: boolean;
  /** 面向执行 Agent 的简短选取依据，不包含秘密。 */
  reason: string;
}

/** 单次工具调用完成选择，不运行子浏览器循环，也不占用业务步骤模型额度。 */
export async function selectIdentity(
  config: AgentConfig,
  input: IdentitySelectionInput,
  signal: AbortSignal,
): Promise<IdentityChoice> {
  const body = {
    model: config.model,
    ...(config.thinking ? { thinking: { type: config.thinking } } : {}),
    stream: false,
    parallel_tool_calls: false,
    [config.tokenParameter]: Math.min(config.maxTokens, 2000),
    messages: [
      { role: 'system', content: IDENTITY_SELECTOR_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          task: input.task,
          candidates: input.candidates,
        }),
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'identity_select',
          description: '选择一个适用身份或声明无需身份、需要人工处理。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              identityId: { type: ['string', 'null'] },
              needsIdentity: { type: 'boolean' },
              reason: { type: 'string', minLength: 1, maxLength: 1000 },
            },
            required: ['identityId', 'needsIdentity', 'reason'],
          },
        },
      },
    ],
    tool_choice: 'required',
  };
  const raw = (await jsonRequest(
    `${config.modelUrl}/chat/completions`,
    config.modelKey,
    'POST',
    body,
    Math.min(config.modelMs, 60_000),
    signal,
  )) as {
    choices?: Array<{
      finish_reason?: string;
      message?: {
        tool_calls?: Array<{ function?: { name: string; arguments: string } }>;
      };
    }>;
  };
  const choice = raw.choices?.[0];
  const calls = choice?.message?.tool_calls;
  if (
    choice?.finish_reason === 'length' ||
    calls?.length !== 1 ||
    calls[0]?.function?.name !== 'identity_select'
  )
    throw new AgentFault(
      'INVALID_IDENTITY_SELECTION',
      '身份选择未返回有效工具调用',
    );
  let result: IdentityChoice;
  try {
    result = JSON.parse(calls[0].function.arguments);
  } catch {
    throw new AgentFault('INVALID_IDENTITY_SELECTION', '身份选择参数无效');
  }
  if (
    !result ||
    Object.keys(result).some(
      (key) => !['identityId', 'needsIdentity', 'reason'].includes(key),
    ) ||
    typeof result.needsIdentity !== 'boolean' ||
    typeof result.reason !== 'string' ||
    !result.reason.trim() ||
    result.reason.length > 1000 ||
    (result.identityId !== null &&
      !input.candidates.some(
        (candidate) => candidate.id === result.identityId,
      )) ||
    (result.identityId !== null && !result.needsIdentity)
  )
    throw new AgentFault(
      'INVALID_IDENTITY_SELECTION',
      '身份选择不属于当前候选',
    );
  return result;
}

/** 领取身份选择工作与实际浏览器任务分开；模型故障进入人工，不阻塞整条执行队列。 */
export async function prepareIdentitySelection(
  config: AgentConfig,
  signal: AbortSignal,
): Promise<void> {
  const request = (path: string, body: unknown) =>
    jsonRequest(
      `${config.apiUrl}/v1/worker/identity-selection/${path}`,
      config.workerToken,
      'POST',
      body,
      config.requestMs,
      signal,
    );
  const response = (await request('claim', {})) as {
    selection: IdentitySelectionInput | null;
  };
  if (!response.selection) return;
  let selected: IdentityChoice;
  try {
    selected = await selectIdentity(config, response.selection, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    selected = {
      identityId: null,
      needsIdentity: true,
      reason: '身份选择暂不可用，请人工确认本次测试需要的账号。',
    };
  }
  await request('finish', {
    taskId: response.selection.taskId,
    token: response.selection.token,
    ...selected,
  });
}
