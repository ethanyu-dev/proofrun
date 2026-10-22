import type { DecisionContextData } from '../execution/context.js';
import type { Observation } from '../evidence/observation.js';

/** 本轮计划明确指定、或最近一次成功定向滚动使用的唯一可见容器。
 * 仅用于限制候选服务的整页滚动；不把旧 target 复用为当前动作权限。
 */
export function scopedScrollTarget(
  context: DecisionContextData,
  page: Observation,
) {
  if (!context.plan?.allowedActions?.includes('scroll')) return undefined;
  const containers = page.targets.filter(
    (target) =>
      target.visible !== false &&
      !target.disabled &&
      target.operations?.includes('scroll'),
  );
  const scope = context.plan.scope.trim().toLowerCase();
  const scoped = scope
    ? containers.filter((target) => target.name.trim().toLowerCase() === scope)
    : [];
  if (scope) return scoped.length === 1 ? scoped[0] : undefined;
  const last = context.recentOperations.findLast(
    (op) => op.operation === 'browser.act',
  );
  if (
    last?.action !== 'scroll' ||
    last.operationStatus !== 'SUCCEEDED' ||
    last.effect !== 'COMPLETED' ||
    !last.targetName?.trim()
  )
    return undefined;
  const matches = containers.filter(
    (target) => target.name === last.targetName,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
