import type { AgentDecision } from '@proofrun/contracts';
import { AgentFault } from '../http.js';

/** Schema 先行定义的能力尚无执行实现，不能公布给模型或作为节点命令派发。 */
const PENDING_DECISION_TYPES = [
  'evidence.read',
  'browser.batch',
] as const satisfies readonly AgentDecision['type'][];

/** 只收窄执行能力，不改变共享 Schema 对决定结构的校验。 */
type SupportedDecision = Exclude<
  AgentDecision,
  { type: (typeof PENDING_DECISION_TYPES)[number] }
>;

/** 工具列表与执行端使用同一能力边界，避免模型被要求调用尚未实现的工具。 */
export function supportsDecisionType(type: AgentDecision['type']): boolean {
  return !PENDING_DECISION_TYPES.some((pending) => pending === type);
}

/** 在任何结论、工作流更新或命令派发之前拒绝未实现决定，并沿用有界模型纠错。 */
export function requireSupportedDecision(
  decision: AgentDecision,
): asserts decision is SupportedDecision {
  if (!supportsDecisionType(decision.type))
    throw new AgentFault(
      'INVALID_MODEL_DECISION',
      `当前执行器尚不支持 ${decision.type}，请使用本轮公布的工具`,
    );
}
