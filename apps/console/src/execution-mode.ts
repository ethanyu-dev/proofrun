import type { TaskDetail } from '@proofrun/contracts';

/** 当前执行统一使用 LLM，省略模式的任务使用相同名称。 */
export function executionModeLabel(
  _mode: TaskDetail['definition']['executionMode'],
) {
  return '纯 LLM';
}
