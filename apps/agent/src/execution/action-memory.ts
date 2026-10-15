import type { RecentOperation } from './context.js';

/** 保留当前步骤的关键动作，滚动和观察不能挤掉已经填写的事实；超限明确声明省略。 */
const ACTION_LIMIT = 24;
/** 控件名称只帮助定位历史动作，不携带可重放的目标或输入值。 */
const NAME_LIMIT = 160;

/** 已执行动作不等于业务结果；独立于近期操作窗口，步骤和控制权变化后重建。 */
export class ActionMemory {
  /** 有界动作回执，不保存输入值或可直接用于操作的 target。 */
  private items: Array<
    Pick<
      RecentOperation,
      'commandId' | 'action' | 'targetName' | 'operationStatus' | 'effect'
    >
  > = [];
  /** 超限遗失的回执数量，防止模型将当前清单当作完整历史。 */
  private omitted = 0;

  /** 只保留实际回执，不保存密码、邀请码等输入内容，也不将失败尝试描述为成功。 */
  record(operation: RecentOperation) {
    if (
      operation.operation !== 'browser.act' ||
      ['scroll', 'hover'].includes(operation.action ?? '')
    )
      return;
    this.items.push({
      commandId: operation.commandId,
      ...(operation.action === undefined ? {} : { action: operation.action }),
      ...(operation.targetName === undefined
        ? {}
        : { targetName: operation.targetName.slice(0, NAME_LIMIT) }),
      operationStatus: operation.operationStatus,
      effect: operation.effect,
    });
    if (this.items.length > ACTION_LIMIT) {
      this.items.shift();
      this.omitted++;
    }
  }

  /** 仅提供历史执行事实，不作为验收附件或当前字段值的证明。 */
  view() {
    return { items: structuredClone(this.items), omitted: this.omitted };
  }
}
