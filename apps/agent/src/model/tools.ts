import { OBSERVATION_REVIEW_ROUNDS } from '../evidence/changes.js';
import type { AgentDecision } from '@proofrun/contracts';

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
  const ids: string[] | undefined = context.task?.acceptanceCriteria?.map(
    (c: { id: string }) => c.id,
  );
  return tools
    .filter(
      (tool) =>
        (context.environmentReview?.required
          ? tool.type === 'verification.environment'
          : tool.type !== 'verification.environment') &&
        (tool.type !== 'browser.cookies.clear' || context.cleanup === true) &&
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
      return { ...tool, parameters };
    });
}
