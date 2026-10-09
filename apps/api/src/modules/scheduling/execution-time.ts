/** 单次人工处理链接有效四小时；链接失效不等于取消等待中的任务。 */
export const HITL_LINK_MS = 4 * 60 * 60_000;
/** 每次成功交还自动执行权后，重新获得完整的二十分钟执行预算。 */
export const RESUMED_EXECUTION_MS = 20 * 60_000;

/** 人工等待暂停执行时钟，worker 和节点租约仍独立到期。 */
export function executionDeadline(context: {
  control_mode: string;
  deadline_at: Date;
}): number {
  return ['REQUESTED', 'HUMAN'].includes(context.control_mode)
    ? Infinity
    : context.deadline_at.getTime();
}
