import { createHash } from 'node:crypto';
import type {
  CaseStep,
  VerificationCaseV2,
  VerificationTask,
} from '@proofrun/contracts';
import { ApiError } from '../../domain.js';
import { caseBudget, type CaseProfile } from './profile.js';

/** 前缀将新版 case 与旧公开入口、普通内部任务隔离。 */
export const V2_PREFIX = 'case-v2-';
/** 主任务、双跑从组及清理的保留前缀，禁止普通任务占用这些服务端身份。 */
export const CASE_TASK_ID =
  /^(case-v2-|cleanup-case-v2-|comparison-case-v2-|cleanup-comparison-case-v2-)/;
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

/** 保存原始请求与平台快照；互斥只覆盖本次 case 及其清理，不让历史清理阻塞新任务。 */
export function compileCase(
  input: VerificationCaseV2,
  profile: CaseProfile,
): VerificationTask {
  const businessSteps = normalizeSteps(input.steps);
  const cleanupSteps = normalizeSteps(
    input.cleanup.map((step, index) => ({
      ...step,
      stepId: step.stepId ?? `cleanup-${index + 1}`,
      type: 'setup',
      policy: step.policy ?? [],
      expected: step.expected ?? [],
    })),
  );
  const steps = [...businessSteps, ...cleanupSteps];
  // 两段分别排序后拼接；清理顺序不能把它插入业务步骤之间。
  if (new Set(steps.map((step) => step.stepId)).size !== steps.length)
    throw new ApiError(422, 'INVALID_CASE', '业务和清理步骤身份不能重复');
  const budget = caseBudget(profile, businessSteps.length);
  const waitMs = businessSteps.reduce(
    (total, step) => total + (step.wait?.durationMs ?? 0),
    0,
  );
  if (waitMs >= budget.timeoutMs)
    throw new ApiError(
      422,
      'WAIT_EXCEEDS_BUDGET',
      '显式等待总时长必须小于平台任务预算，并为排队和操作预留时间',
    );
  const scope = JSON.stringify([
    `${V2_PREFIX}${input.caseId}`,
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
    budget,
    cleanupStepIds: cleanupSteps.map((step) => step.stepId!),
    executionMode: profile.executionMode ?? 'parallel',
    purpose: 'verification',
    steps: steps as NonNullable<VerificationTask['steps']>,
    acceptanceCriteria: stepCriteria(steps, profile.evidenceKinds),
    resourceKey: createHash('sha256').update(scope).digest('hex'),
    caseV2Definition: structuredClone(input),
  };
}

/** 兼容历史冻结定义的独立清理；新 case 不再通过此处生成任务。 */
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

/** 双跑保留旧主任务路径，另一组使用独立命名空间，避免与带后缀的 caseId 冲突。 */
export function caseArmIds(task: VerificationTask): string[] {
  const primaryId = task.comparison?.sourceTaskId ?? task.taskId;
  return task.comparison
    ? [primaryId, `comparison-${primaryId}-jev`]
    : [primaryId];
}

/** 仅首次提交拆组；各组共享初始登录快照，但各自的清理锁不能阻塞另一组。 */
export function expandCaseTasks(task: VerificationTask): VerificationTask[] {
  if (task.executionMode !== 'parallel') return [task];
  return (['llm', 'jev'] as const).map((arm) => ({
    ...structuredClone(task),
    taskId: arm === 'llm' ? task.taskId : `comparison-${task.taskId}-jev`,
    executionMode: arm,
    comparison: { id: task.taskId, sourceTaskId: task.taskId, arm },
    resourceKey: createHash('sha256')
      .update(`${task.resourceKey}:${arm}`)
      .digest('hex'),
  }));
}
