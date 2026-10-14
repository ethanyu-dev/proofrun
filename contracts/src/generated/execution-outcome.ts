/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 执行原因投影；不改写生命周期与验收结论，终止原因不覆盖已确认的环境阻塞。
 */
export interface ExecutionOutcome {
  /**
   * 面向用户的执行分类，与验收结果分开。
   */
  category:
    | 'QUEUED'
    | 'RUNNING'
    | 'COMPLETED'
    | 'CANCELLED'
    | 'WAITING_HUMAN'
    | 'HUMAN_TIMEOUT'
    | 'ENVIRONMENT_BLOCKED'
    | 'EXECUTION_BLOCKED'
    | 'QUEUE_TIMEOUT'
    | 'EXECUTION_TIMEOUT'
    | 'BUDGET_EXHAUSTED'
    | 'WORKER_ERROR'
    | 'NODE_ERROR'
    | 'SESSION_ERROR'
    | 'MODEL_ERROR'
    | 'SERVICE_ERROR'
    | 'BROWSER_ERROR'
    | 'CLEANUP_ERROR'
    | 'EXECUTION_ERROR'
    | 'HUMAN_UNEXECUTABLE';
  /**
   * 主要原因；旧 AGENT_ERROR 可由报告具体原因细分。
   */
  reasonCode: string | null;
  /**
   * 控制面原始终止码，不覆盖主要环境阻塞。
   */
  terminationCode: string | null;
  /**
   * 当前未完成人工请求原文，不参与自然语言分类。
   */
  detail: string | null;
  /**
   * 本轮人工请求开始时间，历史缺失为 null。
   */
  waitingSince: string | null;
  /**
   * 本轮固定等待截止时间，历史缺失为 null。
   */
  waitDeadline: string | null;
}
