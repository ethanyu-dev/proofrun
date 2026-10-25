import type { VerificationTask } from '@proofrun/contracts';
import { AgentFault } from '../http.js';

/** 新执行只有 LLM；历史模式可读取，但必须重新提交为当前策略后执行。 */
export function executionStrategy(task: VerificationTask): 'llm' {
  if ((task.executionMode && task.executionMode !== 'llm') || task.comparison)
    throw new AgentFault(
      'EXECUTION_MODE_RETIRED',
      '历史 JEV/双跑任务不能直接执行，请使用 LLM 创建新运行',
    );
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
