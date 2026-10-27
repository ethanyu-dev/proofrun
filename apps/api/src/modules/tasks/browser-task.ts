import type { BrowserTaskRequest, VerificationTask } from '@proofrun/contracts';
import type { ApiConfig } from '../../config.js';

/** 未配置平台预算时，单次浏览器任务最多执行二十分钟和一百次动作。 */
const DEFAULT_BUDGET = { timeoutMs: 1_200_000, maxActions: 100 };

/** 仅继承平台的调度位置与人工权限，不继承历史登录槽或 case 步骤。 */
export function browserTask(
  input: BrowserTaskRequest,
  config: ApiConfig,
): VerificationTask {
  const profile = config.caseProfile;
  return {
    protocolVersion: '0.1',
    taskKind: 'browser',
    taskId: input.taskId,
    target: { url: input.url },
    objective: input.objective,
    acceptanceCriteria: [],
    executionMode: 'llm',
    environment: {
      id: profile?.environment.id ?? 'default',
      nodePool: profile?.environment.nodePool ?? 'internal',
      allowIntervention: profile?.environment.allowIntervention ?? true,
    },
    budget: { ...DEFAULT_BUDGET, ...profile?.budget },
  };
}
