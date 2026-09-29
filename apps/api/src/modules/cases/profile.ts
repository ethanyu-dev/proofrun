import { readFileSync } from 'node:fs';
import {
  validateVerificationTask,
  type VerificationTask,
} from '@proofrun/contracts';

/** 平台执行配置仅从服务端加载，不接受 case 请求覆盖。 */
export type CaseProfile = Pick<VerificationTask, 'environment' | 'budget'> & {
  /** 单次 case 只运行一组；对比属于内部实验能力。 */
  executionMode: 'llm' | 'jev';
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
const MAX_TASK_MS = 86_400_000;
const MAX_ACTIONS = 10_000;

/** 复用内部任务约束，在服务启动时拒绝拼错字段、并行模式和无效预算。 */
export function validateCaseProfile(value: unknown): CaseProfile {
  const invalid = () => new Error('case 执行配置无效，请检查服务端配置文件');
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid();
  const profile = value as Record<string, unknown>;
  if (
    Object.keys(profile).some((key) => !PROFILE_KEYS.includes(key)) ||
    !['llm', 'jev'].includes(String(profile.executionMode))
  )
    throw invalid();
  const probe = {
    protocolVersion: '0.1',
    taskId: 'case-profile-validation',
    objective: '配置结构校验',
    environment: profile.environment,
    target: { url: PROFILE_VALIDATION_URL },
    budget: profile.budget,
    executionMode: profile.executionMode,
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
