import type { RecentOperation } from './context.js';

/** 最近操作与关键回执共用同一记录，分别有界投影，不复制输入值到长期记忆。 */
const RECENT_LIMIT = 8;
const IMPORTANT_LIMIT = 24;
const NAME_LIMIT = 160;

/** 只保留近期记录和本步骤关键动作的并集，完整审计仍属于控制面。 */
export class OperationJournal {
  /** 单调命令序号只用于窗口归属，不作为控制面命令 ID。 */
  private sequence = 0;
  /** 当前步骤或控制代次的关键回执起点。 */
  private scopeStart = 0;
  /** 当前范围内已因关键回执上限省略的数量。 */
  private omitted = 0;
  /** 近期操作和关键操作的有界并集。 */
  private entries: Array<{ sequence: number; operation: RecentOperation }> = [];
  /** 滚动和悬停不会挤掉已经发生的关键交互回执。 */
  private important(operation: RecentOperation) {
    return (
      operation.operation === 'browser.cookies.clear' ||
      (operation.operation === 'browser.act' &&
        !['scroll', 'hover'].includes(operation.action ?? ''))
    );
  }
  /** 新步骤开始新的模型可见范围；控制权变化不能抹掉已发生的副作用。 */
  beginScope() {
    this.scopeStart = this.sequence;
    this.omitted = 0;
    this.prune();
  }
  /** 每个实际命令回执只登记一次。 */
  record(operation: RecentOperation) {
    this.entries.push({ sequence: ++this.sequence, operation });
    this.prune();
  }
  /** 非近期的关键记录移除输入值，保留事实和来源。 */
  private prune() {
    const important = this.entries.filter(
      (e) => e.sequence > this.scopeStart && this.important(e.operation),
    );
    this.omitted += Math.max(0, important.length - IMPORTANT_LIMIT);
    const retained = new Set(
      important.slice(-IMPORTANT_LIMIT).map((e) => e.sequence),
    );
    const recentAfter = this.sequence - RECENT_LIMIT;
    this.entries = this.entries.filter(
      (e) => e.sequence > recentAfter || retained.has(e.sequence),
    );
    for (const entry of this.entries)
      if (entry.sequence <= recentAfter) delete entry.operation.value;
  }
  /** 普通操作窗口包含观察回执，维持既有上下文语义。 */
  recent() {
    return this.entries
      .filter(
        (e) =>
          e.sequence > this.scopeStart &&
          e.sequence > this.sequence - RECENT_LIMIT,
      )
      .map((e) => e.operation);
  }
  /** 关键回执不含值和可重放 target，省略数明确说明覆盖缺口。 */
  critical() {
    const items = this.entries
      .filter(
        (e) => e.sequence > this.scopeStart && this.important(e.operation),
      )
      .map(({ operation: op }) => ({
        commandId: op.commandId,
        operation: op.operation,
        ...(op.action === undefined ? {} : { action: op.action }),
        ...(op.targetName === undefined
          ? {}
          : { targetName: op.targetName.slice(0, NAME_LIMIT) }),
        ...(op.requestedTargetName === undefined
          ? {}
          : {
              requestedTargetName: op.requestedTargetName.slice(0, NAME_LIMIT),
            }),
        ...(op.keyboard === undefined ? {} : { keyboard: { ...op.keyboard } }),
        ...(op.cookieCleanup
          ? { cookieCleanup: structuredClone(op.cookieCleanup) }
          : {}),
        operationStatus: op.operationStatus,
        effect: op.effect,
      }));
    return { items, omitted: this.omitted };
  }
}
