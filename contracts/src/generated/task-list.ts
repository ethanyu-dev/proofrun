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
   * 清理所属的主任务身份；列表相邻行不代表归属。旧响应可缺失。
   */
  parentTaskId?: string | null;
  id: string;
  objective: string;
  node_pool: string;
  target_url: string;
  state: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'TIMED_OUT' | 'ERROR';
  created_at: string;
  finished_at: string | null;
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
}
