import type { VerificationTask } from './generated/verification-task.js';

/** 同一 profile 的模型并发上限；浏览器命令仍由节点按标签页安全串行。 */
export const PROFILE_CONCURRENCY = 2;

/** 按已排序的 setup 边界拆组；内部组号不会与用户步骤名或清理作用域冲突；首个 setup 前的旧式验证形成独立隐式组。 */
export function compileProfilePlan(
  steps: NonNullable<VerificationTask['steps']>,
): NonNullable<VerificationTask['profilePlan']> {
  const groups: Array<{ id: string; stepIds: [string, ...string[]] }> = [];
  for (const step of steps) {
    if (step.type === 'setup' || !groups.length)
      groups.push({
        id: `group-${groups.length + 1}`,
        stepIds: [step.stepId!],
      });
    else groups.at(-1)!.stepIds.push(step.stepId!);
  }
  if (!groups.length) throw new Error('profile 至少需要一个步骤');
  return {
    version: 1,
    maxConcurrency: PROFILE_CONCURRENCY,
    groups: groups as NonNullable<VerificationTask['profilePlan']>['groups'],
  };
}

/** 从冻结计划查找步骤归属；清理不属于任一业务 tab。 */
export function profileGroup(task: VerificationTask, stepId: string) {
  return task.profilePlan?.groups.find((group) =>
    group.stepIds.includes(stepId),
  );
}
