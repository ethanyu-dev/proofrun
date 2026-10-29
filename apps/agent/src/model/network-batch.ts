import { validateAgentDecision } from '@proofrun/contracts';
import {
  MAX_NETWORK_READS,
  type NetworkReadDecision,
} from '@proofrun/execution-core/evidence/network-reads';
import { AgentFault } from '../http.js';
import type { DecisionTool } from './tools.js';

/** 供应商回复结构先按未知输入校验，不相信 parallel_tool_calls=false 一定被遵守。 */
export interface ModelToolCall {
  /** 仅支持函数工具，不能将其它供应商消息当作可执行指令。 */
  type: 'function';
  /** 名称须匹配当前开放工具，参数必须是序列化 JSON 字符串。 */
  function: { name: string; arguments: string };
}

/** 单项和批次共用外层校验，畸形回复必须进入协议纠错而非抛出原生异常。 */
export function isModelToolCall(value: unknown): value is ModelToolCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const call = value as Partial<ModelToolCall>;
  return (
    call.type === 'function' &&
    !!call.function &&
    typeof call.function === 'object' &&
    !Array.isArray(call.function) &&
    typeof call.function.name === 'string' &&
    typeof call.function.arguments === 'string'
  );
}

/** 仅兼容纯网络读取批次；整批校验成功才交给执行器，绝不静默丢弃后续调用。 */
export function networkBatch(
  calls: unknown[],
  available: DecisionTool[],
): NetworkReadDecision[] {
  if (calls.length > MAX_NETWORK_READS)
    throw new AgentFault(
      'INVALID_MODEL_DECISION',
      `一次最多读取 ${MAX_NETWORK_READS} 项网络证据，请拆分查询。`,
    );
  return calls.map((call) => {
    if (!isModelToolCall(call))
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '网络批次中有非法工具结构，整批未执行；每项必须包含函数名称和 JSON 参数字符串。',
      );
    const tool = available.find((tool) => tool.name === call.function?.name);
    if (
      call.type !== 'function' ||
      !tool ||
      !['network.requests', 'network.request_detail'].includes(tool.type)
    )
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '多个工具调用只允许纯网络证据读取；浏览器动作、结论登记和结束步骤必须单独调用，本批次未执行。',
      );
    let args: unknown;
    try {
      args = JSON.parse(call.function?.arguments ?? '');
    } catch {
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '网络批次中有非 JSON 参数，整批未执行；请逐项按工具 schema 修正。',
      );
    }
    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      'type' in args ||
      'progress' in args
    )
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '批量网络读取只接受查询参数；progress 请用单独的 verification_record 保存，整批未执行。',
      );
    const decision = { ...args, type: tool.type };
    if (!validateAgentDecision(decision))
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        '网络批次参数不符合工具 schema，整批未执行；请修正观察身份、请求 ID、筛选条件或分页偏移。',
      );
    return decision as NetworkReadDecision;
  });
}
