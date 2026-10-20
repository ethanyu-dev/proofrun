import type { TokenUsage } from '@proofrun/contracts';

/** 只接受已上报的非负整数；历史空字段保持空，不猜测供应商计费。 */
export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** 无记录不冒充零消耗；有实际零用量回复时会累计出 0。 */
export function emptyUsage(): TokenUsage {
  return {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    calls: 0,
  };
}

/** 只合并已返回部分；调用数独立于是否取得 usage。 */
export function addUsage(
  target: TokenUsage,
  input: unknown,
  output: unknown,
  calls = 1,
) {
  const prompt = tokenCount(input);
  const completion = tokenCount(output);
  if (prompt !== null)
    target.promptTokens = (target.promptTokens ?? 0) + prompt;
  if (completion !== null)
    target.completionTokens = (target.completionTokens ?? 0) + completion;
  target.calls += calls;
  target.totalTokens =
    target.promptTokens === null && target.completionTokens === null
      ? null
      : (target.promptTokens ?? 0) + (target.completionTokens ?? 0);
}
