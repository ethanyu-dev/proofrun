import { agentDecisionSchema, type AgentDecision } from '@proofrun/contracts';
import type { DecisionContextData } from './context.js';

/** 入口和模型工具发现共用能力投影；最终动作、证据、预算仍由驱动再次校验。 */
export function allowedDecisionTypes(
  context: DecisionContextData,
): AgentDecision['type'][] {
  return agentDecisionSchema.oneOf
    .map(
      (branch: { properties: { type: { const: string } } }) =>
        branch.properties.type.const as AgentDecision['type'],
    )
    .filter(
      (type: AgentDecision['type']) =>
        type !== 'verification.environment' &&
        (type !== 'context.read' ||
          (context.page.view && context.page.view !== 'page') ||
          !!context.page.runtimeLists?.length) &&
        (type !== 'verification.record' ||
          !['PREPARING', 'CHECKING'].includes(context.state.phase)) &&
        (!context.state.settlement ||
          (context.state.settlement === 'budget'
            ? [
                'verification.record',
                'verification.finish',
                'verification.block',
              ]
            : ['verification.record', 'verification.block']
          )
            .concat([
              'network.requests',
              'network.request_detail',
              'context.read',
            ])
            .includes(type)) &&
        (!type.startsWith('network.') ||
          !!context.page.network?.evidenceRefs.length) &&
        (type !== 'verification.intervene' ||
          context.task.permissions.allowIntervention) &&
        (type !== 'browser.cookies.clear' ||
          context.state.phase === 'CLEANUP') &&
        (!['browser.act', 'browser.wait'].includes(type) ||
          !context.page.view ||
          context.page.view === 'page') &&
        (type !== 'browser.act' || context.budget.actions > 0) &&
        (type !== 'browser.observe' ||
          !context.feedback.some(
            (item) => item.code === 'OBSERVATION_STALLED',
          )),
    );
}
