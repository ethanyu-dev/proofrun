import type { TaskDetail } from '@proofrun/contracts';

/** 历史模式只用于还原执行事实，所有重跑都使用当前 LLM 单组。 */
export const HISTORICAL_EXECUTION_NOTICE =
  '这是历史执行记录。JEV 与双跑模式已停用，重新执行将创建 LLM 单组运行。';

/** 使用任务冻结的执行模式；兼容未记录模式的历史纯 LLM 任务。 */
export function executionModeLabel(
  mode: TaskDetail['definition']['executionMode'],
) {
  return mode === 'jev'
    ? 'JEV + LLM（历史，已停用）'
    : mode === 'parallel'
      ? '历史对照（纯 LLM / JEV + LLM，已停用）'
      : '纯 LLM';
}
