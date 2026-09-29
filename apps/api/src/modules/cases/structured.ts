import { createHash } from 'node:crypto';
import type {
  CaseStep,
  VerificationCaseV2,
  VerificationTask,
} from '@proofrun/contracts';
import { ApiError } from '../../domain.js';
import type { CaseProfile } from './profile.js';

/** 前缀将新版 case 与旧公开入口、普通内部任务隔离。 */
export const V2_PREFIX = 'case-v2-';
/** 批量提交必须有界，避免长事务和过量任务占用。 */
export const MAX_CASE_BATCH = 32;

/** 补充稳定身份后排序，同序保留输入顺序；绝不按文字猜测执行顺序。 */
export function normalizeSteps(steps: CaseStep[]): CaseStep[] {
  const normalized = steps.map((step, i) => ({
    ...structuredClone(step),
    stepId: step.stepId ?? `step-${i + 1}`,
  }));
  if (new Set(normalized.map((step) => step.stepId)).size !== normalized.length)
    throw new ApiError(
      422,
      'INVALID_CASE',
      '步骤身份不能重复，包括自动生成的身份',
    );
  return normalized.sort((a, b) => a.exec_order - b.exec_order);
}

/** 每条标准只来自 expected，policy 不能被悄悄转成验收标准。 */
export function stepCriteria(
  steps: CaseStep[],
  evidenceKinds: CaseProfile['evidenceKinds'],
): VerificationTask['acceptanceCriteria'] {
  return steps.flatMap((step) =>
    step.expected.map((expectedResult, index) => ({
      id: `${step.stepId}-expected-${index + 1}`,
      stepId: step.stepId!,
      description: step.description,
      expectedResult,
      evidenceKinds: [...evidenceKinds],
    })),
  );
}

/** 保存原始请求与平台快照；同一登录上下文和站点保守串行，包括业务清理。 */
export function compileCase(
  input: VerificationCaseV2,
  profile: CaseProfile,
): VerificationTask {
  const steps = normalizeSteps(input.steps);
  normalizeSteps(
    input.cleanup.map((step) => ({
      ...step,
      type: 'setup',
      policy: step.policy ?? [],
      expected: step.expected ?? [],
    })),
  );
  const waitMs = steps.reduce(
    (total, step) => total + (step.wait?.durationMs ?? 0),
    0,
  );
  if (waitMs >= profile.budget.timeoutMs)
    throw new ApiError(
      422,
      'WAIT_EXCEEDS_BUDGET',
      '显式等待总时长必须小于平台任务预算，并为排队和操作预留时间',
    );
  const scope = JSON.stringify([
    profile.environment.nodePool,
    profile.environment.auth?.nodeId ?? '',
    profile.environment.auth?.stateId ?? profile.environment.id,
    new URL(input.entry).origin,
  ]);
  return {
    protocolVersion: '0.1',
    taskId: `${V2_PREFIX}${input.caseId}`,
    objective:
      input.description ?? `${input.platform}：按定义步骤执行并逐项验收`,
    target: { url: input.entry },
    environment: structuredClone(profile.environment),
    budget: structuredClone(profile.budget),
    executionMode: profile.executionMode,
    purpose: 'verification',
    steps: steps as NonNullable<VerificationTask['steps']>,
    acceptanceCriteria: stepCriteria(steps, profile.evidenceKinds),
    resourceKey: createHash('sha256').update(scope).digest('hex'),
    caseV2Definition: structuredClone(input),
  };
}

/** 清理使用独立任务和完整预算，原定义中的具体恢复值由上游提供，不推测原始业务数据。 */
export function cleanupTask(task: VerificationTask): VerificationTask | null {
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
    budget: structuredClone(task.budget),
    executionMode: task.executionMode ?? 'llm',
    purpose: 'cleanup',
    parentTaskId: task.taskId,
    resourceKey: task.resourceKey!,
    steps: steps as NonNullable<VerificationTask['steps']>,
    acceptanceCriteria: stepCriteria(steps, evidenceKinds),
  };
}
