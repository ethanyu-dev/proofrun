import { readFileSync } from 'node:fs';
import {
  validateVerificationTask,
  type VerificationTask,
} from '@proofrun/contracts';

/** 平台执行配置仅从服务端加载，不接受 case 请求覆盖。 */
export type CaseProfile = Pick<VerificationTask, 'environment'> & {
  /** 省略总时长时按步骤数计算，动作上限仍由平台明确设置。 */
  budget: { timeoutMs?: number; maxActions: number };
  /** v2 默认双跑；旧版 case 保持单组语义。 */
  executionMode?: 'llm' | 'jev' | 'parallel';
  /** 平台选择取证能力，上层只定义业务预期。 */
  evidenceKinds: VerificationTask['acceptanceCriteria'][number]['evidenceKinds'];
};

/** 固定探针仅验证配置结构，不会创建任务或访问目标环境。 */
const PROFILE_KEYS = [
  'environment',
  'budget',
  'executionMode',
  'evidenceKinds',
];
/** 仅供结构探针满足内部任务的入口要求，永不用于实际 case 导航。 */
const PROFILE_VALIDATION_URL = 'https://case-profile.invalid/';
/** 平台总预算的硬上限为一天。 */
const MAX_TASK_MS = 86_400_000;
/** 单任务允许的最多浏览器动作数。 */
const MAX_ACTIONS = 10_000;

/** 每个业务步骤默认贡献五分钟预算，清理阶段由控制面单独计时。 */
export const DEFAULT_STEP_MS = 300_000;

/** 显式总时长优先；没有步骤的旧版任务按一步计算。 */
export function caseBudget(
  profile: CaseProfile,
  stepCount: number,
): VerificationTask['budget'] {
  return {
    ...profile.budget,
    timeoutMs:
      profile.budget.timeoutMs ?? DEFAULT_STEP_MS * Math.max(1, stepCount),
  };
}

/** 复用内部任务约束，在服务启动时拒绝拼错字段和无效预算。 */
export function validateCaseProfile(value: unknown): CaseProfile {
  const invalid = () => new Error('case 执行配置无效，请检查服务端配置文件');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid();
  const profile = value as Record<string, unknown>;
  if (
    Object.keys(profile).some((key) => !PROFILE_KEYS.includes(key)) ||
    (profile.executionMode !== undefined &&
      !['llm', 'jev', 'parallel'].includes(String(profile.executionMode)))
  )
    throw invalid();
  if (
    !profile.budget ||
    typeof profile.budget !== 'object' ||
    Array.isArray(profile.budget)
  )
    throw invalid();
  const probe = {
    protocolVersion: '0.1',
    taskId: 'case-profile-validation',
    objective: '配置结构校验',
    environment: profile.environment,
    target: { url: PROFILE_VALIDATION_URL },
    budget: { timeoutMs: DEFAULT_STEP_MS, ...profile.budget },
    executionMode: profile.executionMode ?? 'parallel',
    acceptanceCriteria: [
      {
        id: 'profile',
        description: '配置结构校验',
        expectedResult: '配置有效',
        evidenceKinds: profile.evidenceKinds,
      },
    ],
  };
  if (
    !validateVerificationTask(probe) ||
    probe.budget.timeoutMs > MAX_TASK_MS ||
    probe.budget.maxActions > MAX_ACTIONS
  )
    throw invalid();
  return structuredClone(value) as CaseProfile;
}

/** 未配置时禁用新 case 提交，避免猜测业务环境；既有 case 仍可查询和取消。 */
export function loadCaseProfile(
  path: string | undefined,
): CaseProfile | undefined {
  return path
    ? validateCaseProfile(JSON.parse(readFileSync(path, 'utf8')))
    : undefined;
}
