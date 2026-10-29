import type { VerificationTask } from '@proofrun/contracts';
import { AgentFault } from '../faults.js';

/** 新执行只有 LLM；不接受其他执行模式。 */
export function executionStrategy(task: VerificationTask): 'llm' {
  if (task.executionMode && task.executionMode !== 'llm')
    throw new AgentFault('EXECUTION_MODE_RETIRED', '任务只支持 LLM 执行');
  const plan = task.sessionPlan;
  // 版本混用时也不能将旧账号要求静默当作无身份执行。
  if (
    plan &&
    (!['guest', 'manual', 'external'].includes(plan.mode) ||
      plan.candidates.length ||
      plan.library ||
      plan.selection)
  )
    throw new AgentFault(
      'LOCAL_IDENTITY_REMOVED',
      '本地身份链路已移除，请重新提交 DevPass 或人工会话任务',
    );
  return 'llm';
}
