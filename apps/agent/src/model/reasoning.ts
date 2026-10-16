import type { AgentConfig } from '../config.js';

/** 显式关闭优先于档位；保留的 effort 不能重新开启思考或扩大身份选择预算。 */
export function thinkingEnabled(config: AgentConfig): boolean {
  return (
    config.thinking !== 'disabled' &&
    (config.thinking === 'enabled' || config.reasoningEffort !== undefined)
  );
}

/** 三条 LLM 路径共用推理参数；不向 TypeSafe 请求混入 Chat Completions 扩展。 */
export function reasoningParameters(config: AgentConfig) {
  return {
    ...(config.thinking ? { thinking: { type: config.thinking } } : {}),
    ...(config.reasoningEffort
      ? { reasoning_effort: config.reasoningEffort }
      : {}),
  };
}

/** DeepSeek 思考模式拒绝 required；auto 只放宽供应商选择，回复仍必须通过单工具及领域校验。 */
export function toolChoice(config: AgentConfig): 'auto' | 'required' {
  return thinkingEnabled(config) ? 'auto' : 'required';
}
