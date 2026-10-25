import type { VerificationTask } from '@proofrun/contracts';
import {
  normalizeSteps,
  stepCriteria,
} from '../src/modules/cases/structured.js';

/** 仅构造升级前清理夹具；不执行浏览器或为生产生成新任务。 */
export function cleanupTask(task: VerificationTask): VerificationTask | null {
  // 仅兼容升级前冻结的定义；新任务在原会话内收尾。
  if (task.cleanupStepIds !== undefined) return null;
  const cleanup = task.caseV2Definition?.cleanup;
  if (!cleanup?.length) return null;
  const steps = normalizeSteps(
    cleanup.map((step) => ({
      ...step,
      type: 'setup',
      policy: step.policy ?? [],
      expected: step.expected ?? [],
    })),
  );
  const evidenceKinds = task.acceptanceCriteria[0]!.evidenceKinds;
  return {
    protocolVersion: task.protocolVersion,
    taskId: `cleanup-${task.taskId}`,
    objective:
      '执行上游声明的业务清理操作；只清理指定对象，不能推测未提供的原值。',
    environment: structuredClone(task.environment),
    target: { url: steps[0]!.url },
    budget: structuredClone(task.cleanupBudget ?? task.budget),
    executionMode: task.executionMode ?? 'llm',
    purpose: 'cleanup',
    parentTaskId: task.taskId,
    resourceKey: task.resourceKey!,
    steps: steps as NonNullable<VerificationTask['steps']>,
    acceptanceCriteria: stepCriteria(steps, evidenceKinds),
  };
}
