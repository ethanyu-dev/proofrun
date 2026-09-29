import type { VerificationTask } from '@proofrun/contracts';
import { AgentFault } from '../http.js';

/** 新任务以显式策略为准，历史对照任务沿用组标识；未拆组请求不能作为单任务执行。 */
export function executionStrategy(task: VerificationTask): 'llm' | 'jev' {
  if (task.executionMode === 'parallel')
    throw new AgentFault(
      'UNEXPANDED_PARALLEL_TASK',
      '并行任务必须先由控制面拆分',
    );
  return task.executionMode ?? task.comparison?.arm ?? 'llm';
}
