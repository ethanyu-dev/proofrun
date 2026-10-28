import type { StepResult } from '@proofrun/contracts';
import type { WorkflowView } from './workflow.js';

/** 每次执行最多三轮环境交接；同一原始条件只交接一次，改写原因不能重新获得额度。 */
export const MAX_ENVIRONMENT_HANDOFFS = 3;
/** 控制协议最多展示十个待办，只登记实际交接的条件，不隐式确认未展示项。 */
const MAX_HANDOFF_ITEMS = 10;

/** 稳定条件身份来自原定义或封闭的登录条件，不从页面文案生成角色规则。 */
export type EnvironmentCondition = NonNullable<
  StepResult['blockage']
>['conditions'][number];

/** 把最近的逐项评估转为缺失清单，原始要求及具体未确认原因同时保留。 */
export function unresolvedRequirements(
  view: WorkflowView,
): EnvironmentCondition[] {
  return view.steps
    .filter((step) => step.status !== 'recorded')
    .map((step) => ({
      id: `requirement:${step.id}`,
      description: step.requirement,
      summary: step.summary ?? '尚未取得该条件的完成证据',
      // 模型的 blocked 声明不能证明账号不符合；只能表示尚未证实准备就绪。
      status: 'UNCONFIRMED',
    }));
}

/** 登录恢复和不同前置条件共享总上限，各自保留一次交接机会。 */
export class EnvironmentHandoffs {
  /** 命名空间包含步骤身份，防止不同步骤同名条件相互消耗机会。 */
  private readonly requested = new Set<string>();
  /** 只有实际获准交接才增长，模型反复改写原因不会重置。 */
  private rounds = 0;

  /** 控制权竞争导致请求未获准时回滚预占，不消耗该条件的人工机会。 */
  release(
    stepId: string,
    conditions: EnvironmentCondition[],
    version = 0,
    rollbackRound = true,
  ) {
    for (const condition of conditions)
      this.requested.delete(`${stepId}/${condition.id}/${version}`);
    if (rollbackRound && conditions.length)
      this.rounds = Math.max(0, this.rounds - 1);
  }

  /** 返回本次可交接事项；空数组表示无新条件或总额度耗尽。 */
  claim(
    stepId: string,
    conditions: EnvironmentCondition[],
    version = 0,
  ): EnvironmentCondition[] {
    if (this.rounds >= MAX_ENVIRONMENT_HANDOFFS) return [];
    const pending = conditions
      .filter(
        (condition) =>
          !this.requested.has(`${stepId}/${condition.id}/${version}`),
      )
      .slice(0, MAX_HANDOFF_ITEMS);
    if (pending.length) {
      this.rounds++;
      for (const condition of pending)
        this.requested.add(`${stepId}/${condition.id}/${version}`);
    }
    return pending;
  }
}
