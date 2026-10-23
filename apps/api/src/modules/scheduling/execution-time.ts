/** 单次人工处理链接有效四小时；链接失效不等于取消等待中的任务。 */
export const HITL_LINK_MS = 4 * 60 * 60_000;
/** 每次成功交还自动执行权后，重新获得完整的二十分钟执行预算。 */
export const RESUMED_EXECUTION_MS = 20 * 60_000;
/** 整段后续清理共用三分钟墙钟预算，人工暂停和后续清理步骤不能重新加时。 */
export const CLEANUP_EXECUTION_MS = 3 * 60_000;

/** 人工等待暂停执行时钟，worker 和节点租约仍独立到期。 */
export function executionDeadline(context: {
  control_mode: string;
  deadline_at: Date;
  cleanup_deadline_at?: Date | null;
  human_deadline_at?: Date | null;
  external_expires_at?: Date | null;
}): number {
  const business = ['REQUESTED', 'HUMAN'].includes(context.control_mode)
    ? (context.human_deadline_at?.getTime() ?? Infinity)
    : context.deadline_at.getTime();
  return Math.min(
    business,
    context.cleanup_deadline_at?.getTime() ?? Infinity,
    context.external_expires_at?.getTime() ?? Infinity,
  );
}

/** 多个期限同时过期时使用最早截止项，避免把清理超时误报成人工超时。 */
export function executionTimeoutCode(
  context: Parameters<typeof executionDeadline>[0],
  taskCode = 'TASK_DEADLINE_EXCEEDED',
): string {
  const deadline = executionDeadline(context);
  if (context.external_expires_at?.getTime() === deadline)
    return 'EXTERNAL_ACCOUNT_EXPIRED';
  if (context.cleanup_deadline_at?.getTime() === deadline)
    return 'CLEANUP_DEADLINE_EXCEEDED';
  if (
    context.control_mode !== 'AUTO' &&
    context.human_deadline_at?.getTime() === deadline
  )
    return 'HUMAN_INTERVENTION_TIMEOUT';
  return taskCode;
}
