import { BROWSER_TASK_PROMPT } from './browser-task.js';
import { CORE_PROMPT, TASK_ROLES } from './core.js';
import { contextPrompts } from './context-rules.js';
import { NETWORK_PROMPT } from './network.js';
import { PHASE_PROMPTS, SETTLEMENT_PROMPT } from './phases.js';
import {
  SINGLE_TOOL_CALL_PROMPT,
  NETWORK_TOOL_CALL_PROMPT,
} from './tool-calls.js';
import type { DecisionContextData } from '@proofrun/execution-core/execution/context';
import type { DecisionTool } from '../model/tools.js';

/** 每轮重建提示词；工具必须是完成权限、预算和截图裁剪后的最终列表。 */
export function decisionPrompt(
  context: DecisionContextData,
  tools: readonly DecisionTool[],
): string {
  const networkAvailable = tools.some((tool) =>
    tool.type.startsWith('network.'),
  );
  return [
    TASK_ROLES[context.task.kind === 'browser' ? 'browser' : 'verification'],
    networkAvailable ? NETWORK_TOOL_CALL_PROMPT : SINGLE_TOOL_CALL_PROMPT,
    CORE_PROMPT,
    context.task.kind === 'browser'
      ? BROWSER_TASK_PROMPT
      : PHASE_PROMPTS[context.state.phase],
    ...contextPrompts(context),
    networkAvailable ? NETWORK_PROMPT : '',
    context.state.settlement ? SETTLEMENT_PROMPT : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}
