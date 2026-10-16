import type { DecisionContextData } from '../execution/context.js';

/** 历史正文只合并完全相同的副本，不生成需要模型重建的差分文本。 */
export function compactDecisionText(text: string): string {
  const context = JSON.parse(text);
  if (
    (!context.executionGuidance && !context.executionPolicy) ||
    !Array.isArray(context.previousObservations)
  )
    return text;
  const seen = new Map<string, number>();
  const history: typeof context.previousObservations = [];
  for (const item of context.previousObservations) {
    const key = JSON.stringify([
      item.url,
      item.title,
      item.text,
      item.truncated,
    ]);
    const index = seen.get(key);
    if (index === undefined) {
      seen.set(key, history.length);
      history.push(item);
    } else {
      const previous = history[index];
      // 合并的是正文，不声明历史截图相同；每个原附件与观察身份仍可追溯。
      previous.equivalentTextObservationIds = [
        ...(previous.equivalentTextObservationIds ?? [previous.observationId]),
        item.observationId,
      ];
      previous.artifactRefs = [
        ...new Map(
          [...previous.artifactRefs, ...item.artifactRefs].map((ref) => [
            ref.artifactId,
            ref,
          ]),
        ).values(),
      ];
    }
  }
  context.previousObservations = history;
  return JSON.stringify(context);
}

/** 兼容工作流内部仍持有计划；对新模型只公布顶层 plan，避免两份可修改计划。 */
export function requestContext(context: DecisionContextData) {
  if (!context.executionPolicy || !context.workflow) return context;
  const { recovery: _recovery, ...workflow } = context.workflow;
  return { ...context, workflow };
}
