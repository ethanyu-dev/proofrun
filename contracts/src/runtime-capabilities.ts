/** 能力名称与节点心跳版本映射集中维护；缺字段的旧节点不能冒充支持。 */
export const RUNTIME_CAPABILITIES = {
  runtimeEvidenceV1: 'runtimeEvidenceVersion',
  networkDetailsV1: 'networkDetailsVersion',
  focusRecoveryV1: 'focusRecoveryVersion',
} as const;
export type RuntimeCapability = keyof typeof RUNTIME_CAPABILITIES;

/** 明确的检查术语用于发现能力需求，不据此推断业务标准已经通过。 */
const RUNTIME_CHECK =
  /service\s*worker|serviceworker|cache\s*storage|cachestorage|controller\.state|控制台.{0,12}(?:异常|报错|错误)|console|online\s*事件|派发\s*online/i;
const NETWORK_CHECK =
  /\bHTTP\b|\b[2345]\d\d\b|响应头|重定向|Location|Cache-Control|no-store|networkidle|Content-Type|请求.*重放/i;

/** 显式需求优先保留，已识别文本只能补充；无法识别的自然语言仍由执行器报告证据缺口。 */
export function requiredCapabilities(step: {
  description: string;
  policy?: string[];
  expected?: string[];
  requiredCapabilities?: RuntimeCapability[];
}): RuntimeCapability[] {
  const result = new Set(step.requiredCapabilities ?? []);
  const text = [
    step.description,
    ...(step.policy ?? []),
    ...(step.expected ?? []),
  ].join('\n');
  if (RUNTIME_CHECK.test(text)) result.add('runtimeEvidenceV1');
  if (NETWORK_CHECK.test(text)) result.add('networkDetailsV1');
  return [...result];
}

/** 准入只核验版本，不把忙碌节点与缺少能力混为一谈。 */
export function supportsCapabilities(
  capabilities: Record<string, unknown>,
  required: RuntimeCapability[],
): boolean {
  return required.every(
    (name) => capabilities[RUNTIME_CAPABILITIES[name]] === 1,
  );
}
