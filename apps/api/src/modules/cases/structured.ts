import { refreshExternalSessionBudget } from '../sessions/budget.js';
import { resolveExecutionPlan } from './execution-plan.js';
import { resolveSession } from '../sessions/plan.js';
import {
  compileStepBudget,
  compileProfilePlan,
  businessBudget,
  CASE_MAX_MS,
  CASE_MAX_ACTIONS,
  CASE_MAX_MODEL_CALLS,
} from '@proofrun/contracts';
import type {
  CaseStep,
  VerificationCaseV2,
  VerificationTask,
} from '@proofrun/contracts';
import { ApiError, canonical } from '../../domain.js';
import { DEFAULT_CASE_EXECUTION_MODE, type CaseProfile } from './profile.js';

/** 前缀将新版 case 与旧公开入口、普通内部任务隔离。 */
export const V2_PREFIX = 'case-v2-';
/** 主任务、双跑从组及清理的保留前缀，禁止普通任务占用这些服务端身份。 */
export const CASE_TASK_ID =
  /^(case-(?:v2|run)-|cleanup-case-(?:v2|run)-|comparison-case-(?:v2|run)-|cleanup-comparison-case-(?:v2|run)-)/;
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
  const stepBudget = compileStepBudget({
    steps: steps as NonNullable<VerificationTask['steps']>,
    cleanupStepIds: cleanupSteps.map((step) => step.stepId!),
    executionMode: profile.executionMode ?? DEFAULT_CASE_EXECUTION_MODE,
  });
  const resolved = resolveExecutionPlan(input, profile.evidenceKinds);
  const sessionPlan = resolveSession(
    resolved.session,
    input.entry,
    !!resolved.automatic,
  );
  if (resolved.automatic) sessionPlan.automatic = resolved.automatic;
  // 人工处理页最多呈现十项；在提交时拒绝溢出或冲突，不能事后漏确认某些角色条件。
  for (const step of businessSteps) {
    const checks = new Map<string, unknown>();
    for (const check of [
      ...sessionPlan.requirements,
      ...(step.preconditions ?? []),
    ]) {
      if (
        checks.has(check.id) &&
        canonical(checks.get(check.id)) !== canonical(check)
      )
        throw new ApiError(
          422,
          'IDENTITY_CHECK_CONFLICT',
          '步骤前提与身份条件使用相同 ID 但内容不同',
        );
      checks.set(check.id, check);
    }
    if (
      checks.size > (resolved.automatic?.loginRequired ? 9 : 10) ||
      [...checks.values()].filter(
        (check) => (check as { method: string }).method === 'manual',
      ).length >
        (resolved.plan.environment.mode === 'guest' ||
        resolved.automatic?.loginRequired
          ? 8
          : 9)
    )
      throw new ApiError(
        422,
        'IDENTITY_CHECK_LIMIT',
        '身份条件必须为环境交接保留至少一项位置；访客还需保留一项访客复核',
      );
  }
  const budget = businessBudget(stepBudget);
  if (sessionPlan.external) {
    if (profile.environment.auth && !resolved.automatic)
      throw new ApiError(
        422,
        'EXTERNAL_ACCOUNT_AUTH_CONFLICT',
        '外部账号不能同时恢复本地登录槽',
      );
  }
  if (
    budget.timeoutMs +
      (sessionPlan.external ? sessionPlan.preparationMs : 0) +
      stepBudget.settleMs * businessSteps.length +
      (cleanupSteps.length ? stepBudget.cleanup.timeoutMs : 0) >
      CASE_MAX_MS ||
    budget.maxActions + stepBudget.cleanup.maxActions > CASE_MAX_ACTIONS ||
    stepBudget.steps.reduce((sum, step) => sum + step.maxModelCalls, 0) +
      (cleanupSteps.length ? stepBudget.cleanup.maxModelCalls : 0) >
      CASE_MAX_MODEL_CALLS
  )
    throw new ApiError(
      422,
      'CASE_BUDGET_EXCEEDED',
      '步骤所需预算超过平台上限，请拆分 case；不会削减后续步骤额度',
    );
  const task: VerificationTask = {
    protocolVersion: '0.1',
    taskId: `${V2_PREFIX}${input.caseId}`,
    objective:
      input.description ?? `${input.platform}：按定义步骤执行并逐项验收`,
    target: { url: input.entry },
    // 新 v2 缺省允许人工辅助；不再生成登录复用开关。
    environment: {
      ...structuredClone(profile.environment),
      allowIntervention: profile.environment.allowIntervention ?? true,
    },
    sessionPlan,
    executionPlan: resolved.plan,
    budget,
    stepBudget,
    profilePlan: {
      ...compileProfilePlan(
        businessSteps as NonNullable<VerificationTask['steps']>,
      ),
      ...(businessSteps[0]?.type === 'setup'
        ? { environmentGateStepId: businessSteps[0].stepId! }
        : {}),
    },
    cleanupStepIds: cleanupSteps.map((step) => step.stepId!),
    executionMode: profile.executionMode ?? DEFAULT_CASE_EXECUTION_MODE,
    purpose: 'verification',
    steps: steps as NonNullable<VerificationTask['steps']>,
    acceptanceCriteria: stepCriteria(steps, profile.evidenceKinds),
    caseV2Definition: structuredClone(input),
  };
  if (resolved.automatic) {
    delete task.environment.auth;
    if (task.environment.reuseAuth !== false) delete task.environment.reuseAuth;
  }
  refreshExternalSessionBudget(task);
  return task;
}

/** 双跑保留旧主任务路径，另一组使用独立命名空间，避免与带后缀的 caseId 冲突。 */
export function caseArmIds(task: VerificationTask): string[] {
  const primaryId = task.comparison?.sourceTaskId ?? task.taskId;
  return task.comparison
    ? [primaryId, `comparison-${primaryId}-jev`]
    : [primaryId];
}

/** 新提交只有 LLM 一组，历史双跑的读取仍由 caseArmIds 处理。 */
export function assertCaseExecution(task: VerificationTask): void {
  if (task.executionMode && task.executionMode !== 'llm')
    throw new ApiError(
      422,
      'EXECUTION_MODE_RETIRED',
      '新任务只支持 llm，jev 和 parallel 已退出执行',
    );
}
