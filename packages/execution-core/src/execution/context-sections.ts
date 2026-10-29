import type { Observation } from '../evidence/observation.js';
import type { WorkflowView } from './workflow.js';

/** 要求只在原文完全相同时复用来源；不按相似度折叠，避免丢失细微约束。 */
export function requirementSections(
  requirements: WorkflowView['steps'],
  description: string,
  policy: string[] = [],
) {
  return requirements.map(({ id, requirement }) => {
    const policyIndex = policy.indexOf(requirement);
    const requirementRef =
      requirement === description
        ? 'task.description'
        : policyIndex >= 0
          ? `task.policy[${policyIndex}]`
          : undefined;
    return {
      id,
      requirement: requirementRef ? undefined : requirement,
      requirementRef,
    };
  });
}

/** 当前截图仍需经过服务端决定帧的哈希核验，其余引用只带身份和类型；原始附件不变。 */
export function artifactSections(
  refs: Observation['artifactRefs'],
  hasImage = false,
) {
  return refs.map(({ artifactId, kind, sha256 }) => ({
    artifactId,
    kind,
    sha256: hasImage && kind === 'SCREENSHOT' ? sha256 : undefined,
  }));
}
