import { OBSERVATION_REVIEW_ROUNDS } from '../evidence/changes.js';
import type { AgentDecision } from '@proofrun/contracts';
import { WORKFLOW_SCHEMA } from '../execution/workflow.js';
import { EXHAUSTED_RECOVERY_TOOL } from '../prompts/recovery.js';
import { constrainEvidenceRefs, visibleEvidenceIds } from './evidence-refs.js';

/** 供应商工具描述；动态约束只收紧平台已有协议，不增加执行权限。 */
export interface DecisionTool {
  /** 已注册的封闭决定类型。 */
  type: AgentDecision['type'];
  /** 供应商工具名，将协议中的点转换为下划线。 */
  name: string;
  /** 工具用途说明，不承载页面提供的指令。 */
  description: string;
  /** 基础参数 schema 在当前步骤上进一步收紧。 */
  parameters: object;
}

/** 每轮只公布当前步骤可用的验收身份、清理能力与滚动容器。 */
export function decisionTools(
  text: string,
  tools: DecisionTool[],
): DecisionTool[] {
  const context = JSON.parse(text);
  const evidenceIds = visibleEvidenceIds(context);
  const ids: string[] | undefined = context.task?.acceptanceCriteria?.map(
    (c: { id: string }) => c.id,
  );
  return tools
    .filter(
      (tool) =>
        (!context.verificationReview?.final ||
          ['verification.record', 'verification.block'].includes(tool.type)) &&
        (context.environmentReview?.required
          ? tool.type === 'verification.environment'
          : tool.type !== 'verification.environment') &&
        (tool.type !== 'browser.cookies.clear' || context.cleanup === true) &&
        (tool.type !== 'browser.act' ||
          context.budgetRemaining?.actions !== 0) &&
        (tool.type !== 'browser.observe' ||
          (context.changes?.unchangedRounds ?? 0) <
            OBSERVATION_REVIEW_ROUNDS) &&
        (tool.type !== 'verification.record' ||
          (!!ids?.length &&
            !!context.executionStep &&
            (context.executionStep.type !== 'setup' ||
              context.cleanup === true))),
    )
    .map((tool) => {
      const parameters = structuredClone(tool.parameters) as {
        properties: Record<string, unknown>;
        allOf?: object[];
        required?: string[];
      };
      if (context.workflow)
        parameters.properties.workflow = structuredClone(WORKFLOW_SCHEMA);
      if (
        ids &&
        ['verification.finish', 'verification.record'].includes(tool.type)
      ) {
        const criteria = parameters.properties.criteria as {
          items: { properties: object };
        };
        parameters.properties.criteria = {
          ...criteria,
          maxItems: ids.length,
          ...(ids.length
            ? {
                items: {
                  ...criteria.items,
                  properties: {
                    ...criteria.items.properties,
                    criterionId: { type: 'string', enum: ids },
                  },
                },
              }
            : {}),
        };
      }
      // setup 的空 criteria 不能让供应商省略准备声明；公共执行器仍独立校验完整性。
      if (
        tool.type === 'verification.finish' &&
        context.executionStep?.type === 'setup' &&
        !context.cleanup
      )
        parameters.required = [...(parameters.required ?? []), 'workflow'];
      if (tool.type === 'browser.act') {
        if (context.workflow) {
          const workflow = parameters.properties
            .workflow as typeof WORKFLOW_SCHEMA & {
            required?: string[];
          };
          // 恢复耗尽时明确要求新策略，不能继续生成必定被执行器拒绝的孤立动作。
          if (context.workflow.recovery?.remaining === 0) {
            parameters.required = [...(parameters.required ?? []), 'workflow'];
            workflow.required = ['recovery'];
          }
          if (Number.isInteger(context.budgetRemaining?.actions))
            workflow.properties.recovery.properties.maxActions.maximum =
              Math.min(
                workflow.properties.recovery.properties.maxActions.maximum,
                context.budgetRemaining.actions,
              );
        }
        const scrollTargets =
          context.observation?.targets
            ?.filter((t: { operations?: string[] }) =>
              t.operations?.includes('scroll'),
            )
            .map((t: { target: string }) => t.target) ?? [];
        parameters.allOf = [
          {
            if: {
              properties: { action: { const: 'scroll' } },
              required: ['action'],
            },
            then: scrollTargets.length
              ? { properties: { target: { enum: scrollTargets } } }
              : { not: { required: ['target'] } },
          },
        ];
      }
      constrainEvidenceRefs(parameters, evidenceIds);
      return {
        ...tool,
        ...(tool.type === 'browser.act' &&
        context.workflow?.recovery?.remaining === 0
          ? { description: `${tool.description}；${EXHAUSTED_RECOVERY_TOOL}` }
          : {}),
        parameters,
      };
    });
}
