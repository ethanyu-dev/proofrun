import type { TaskDetail } from '@proofrun/contracts';

/** 使用任务冻结的执行模式；兼容未记录模式的历史纯 LLM 任务。 */
export function executionModeLabel(
  mode: TaskDetail['definition']['executionMode'],
) {
  return mode === 'jev'
    ? 'JEV + LLM'
    : mode === 'parallel'
      ? '并行对比（纯 LLM / JEV + LLM）'
      : '纯 LLM';
}
