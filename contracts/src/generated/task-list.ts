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
  id: string;
  objective: string;
  node_pool: string;
  target_url: string;
  state: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'TIMED_OUT' | 'ERROR';
  created_at: string;
  finished_at: string | null;
  execution_disposition: 'EXECUTED' | 'BLOCKED' | 'ERROR' | null;
  verdict: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | null;
}
