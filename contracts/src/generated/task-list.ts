/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 管理员任务列表；按创建时间和身份倒序游标分页。
 */
export interface TaskList {
  tasks: TaskSummary[];
  nextCursor: string | null;
}
/**
 * 列表摘要只包含展示字段，不返回完整报告和执行凭据。
 */
export interface TaskSummary {
  /**
   * 当前任务的执行模式；历史定义未记录时为 null。
   */
  executionMode?: 'llm' | 'jev' | 'parallel' | null;
  /**
   * 服务端保存的双跑归属；单组为 null，旧响应可缺失，不根据任务名称推测。
   */
  comparison?: null | Comparison;
  /**
   * 清理所属的主任务身份；列表相邻行不代表归属。旧响应可缺失。
   */
  parentTaskId?: string | null;
  id: string;
  /**
   * 结构化 case 的原始身份；两组及历史清理指向同一 case，普通任务为 null。
   */
  caseId?: string | null;
  objective: string;
  node_pool: string;
  target_url: string;
  state: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'TIMED_OUT' | 'ERROR';
  created_at: string;
  finished_at: string | null;
  /**
   * 执行终态的稳定原因，用于区分环境不符合、执行故障与业务结论。
   */
  execution_reason_code?: string | null;
  execution_disposition: 'EXECUTED' | 'BLOCKED' | 'ERROR' | null;
  verdict: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | null;
  /**
   * 验证报告状态：通过、未通过、无法判定；无报告时为 null。执行状态不等于验收结论，已确认失败优先于未覆盖项。
   */
  reportStatus: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | null;
  /**
   * 按本次验收定义统计，各分类之和等于 total；无报告时为 null。
   */
  criteriaCounts: null | {
    /**
     * 本次定义的验收项总数。
     */
    total: number;
    /**
     * 通过项数。
     */
    passed: number;
    /**
     * 未通过项数。
     */
    failed: number;
    /**
     * 已验收但无法判定的项数。
     */
    inconclusive: number;
    /**
     * 未验收或报告缺失的项数。
     */
    skipped: number;
  };
  /**
   * 证据清理时间；清理后保留报告结论。
   */
  archived_at: string | null;
  /**
   * 报告收录的证据数量；无报告为 null，数量不表示证据仍可下载。
   */
  evidenceCount: number | null;
  executionOutcome?: ExecutionOutcome;
}
/**
 * 历史双组对比身份，仅供读取原执行记录；新任务不接受此字段，重跑创建 LLM 单组。
 */
export interface Comparison {
  id: string;
  arm: 'llm' | 'jev';
  sourceTaskId: string;
}
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
