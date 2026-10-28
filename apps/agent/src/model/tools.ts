import { allowedDecisionTypes } from '@proofrun/execution-core/execution/allowed-decisions';
import { TOOL_DESCRIPTIONS } from '../prompts/tools.js';
import type { DecisionContextData } from '../execution/context.js';
import type { AgentDecision } from '@proofrun/contracts';
import { agentDecisionSchema } from '@proofrun/contracts';
import { constrainEvidenceRefs } from './evidence-refs.js';
import { SCROLL_DIRECTIONS } from '../execution/scroll-distance.js';

/** 供应商接口只表达本轮能力，不增加控制面权限。 */
export interface DecisionTool {
  type: AgentDecision['type'];
  name: string;
  description: string;
  parameters: object;
}

/** 所有工具共享进度入口，公开报告继续使用原有领域协议。 */
export function decisionTools(
  context: DecisionContextData,
  tools: DecisionTool[],
): DecisionTool[] {
  const ids = context.task.criteria.map((item) => item.id);
  const progress = structuredClone(agentDecisionSchema.definitions.progress);
  const criteria = progress.properties.criteria;
  criteria.items.properties.criterionId = ids.length
    ? { type: 'string', enum: ids }
    : { type: 'string' };
  criteria.minItems = 0;
  criteria.maxItems = ids.length;
  const requirements = progress.properties.requirements;
  requirements.maxItems = context.task.requirements.length;
  requirements.items.properties.id = {
    type: 'string',
    ...(context.task.requirements.length
      ? { enum: context.task.requirements.map((item) => item.id) }
      : {}),
  };
  return tools
    .filter((tool) => allowedDecisionTypes(context).includes(tool.type))
    .map((tool) => {
      const parameters = structuredClone(tool.parameters) as {
        properties: Record<string, unknown>;
        required?: string[];
        allOf?: object[];
      };
      parameters.properties.progress = structuredClone(progress);
      if (tool.type.startsWith('network.') && context.page.network) {
        parameters.properties.observationId = {
          type: 'string',
          const: context.page.network.observationId,
          description: '当前已采集网络快照身份，读取不刷新页面。',
        };
      }
      if (
        context.task.kind === 'browser' &&
        tool.type === 'verification.finish'
      ) {
        parameters.properties.summary = {
          type: 'string',
          minLength: 1,
          description:
            '交付原目标要求的结果正文，含查询数据、表格、来源或操作结果。',
        };
      }
      // record 的必填 progress 已由 Contracts 定义；这里只补充 finish 的阶段约束。
      if (
        tool.type === 'verification.finish' &&
        ['PREPARING', 'CHECKING'].includes(context.state.phase)
      )
        parameters.required = [...(parameters.required ?? []), 'progress'];
      if (tool.type === 'browser.act') {
        parameters.properties.revisitReason = {
          type: 'string',
          minLength: 1,
          maxLength: 600,
        };
        const targets = context.page.targets.map((item) => item.target);
        const pressTargets = context.page.targets
          .filter(
            (item) =>
              item.focusable !== false &&
              item.ariaHidden !== true &&
              item.disabled !== true,
          )
          .map((item) => item.target);
        const actionSchema = parameters.properties.action as { enum: string[] };
        actionSchema.enum = actionSchema.enum.filter(
          (action) =>
            !['online', 'pwa.cleanup', 'network.probe'].includes(action) ||
            (context.page.runtime?.version === 1 &&
              (action !== 'pwa.cleanup' || context.state.phase === 'CLEANUP')),
        );

        const scrollTargets = context.page.targets
          .filter((item) => item.operations?.includes('scroll'))
          .map((item) => item.target);
        parameters.allOf = [
          {
            if: {
              properties: { action: { const: 'press' } },
              required: ['action'],
            },
            then:
              (context.page.viewport as { targetedPress?: boolean })
                ?.targetedPress && pressTargets.length
                ? { properties: { target: { enum: pressTargets } } }
                : { not: { required: ['target'] } },
          },
          {
            if: {
              properties: { action: { const: 'scroll' } },
              required: ['action'],
            },
            then: {
              required: ['value'],
              properties: {
                value: { type: 'string', enum: [...SCROLL_DIRECTIONS] },
                ...(scrollTargets.length
                  ? { target: { enum: scrollTargets } }
                  : {}),
              },
              ...(scrollTargets.length
                ? {}
                : { not: { required: ['target'] } }),
            },
          },
          {
            if: {
              properties: {
                action: {
                  enum: [
                    'click',
                    'fill',
                    'type',
                    'hover',
                    'check',
                    'uncheck',
                    'select',
                  ],
                },
              },
              required: ['action'],
            },
            then: targets.length
              ? { properties: { target: { enum: targets } } }
              : { not: {} },
          },
        ];
      }
      constrainEvidenceRefs(
        parameters,
        context.evidence.map((item) => item.id),
      );
      return {
        ...tool,
        description: TOOL_DESCRIPTIONS[tool.type] ?? tool.description,
        parameters,
      };
    });
}
