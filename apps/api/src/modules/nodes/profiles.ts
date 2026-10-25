import { Database } from '../../db.js';
import { ApiError } from '../../domain.js';
import type { Coordinator } from '../scheduling/coordinator.js';

/** 历史模板只提供原任务链接；关闭复用任务撤权和物理关闭流程。 */
export class HistoricalNodeProfiles {
  constructor(
    private readonly db: Database,
    private readonly tasks: Pick<Coordinator, 'cancel'>,
  ) {}

  /** 不重建导航就绪或模板发布状态机；历史原始记录仍保留在数据库。 */
  async status(id: string) {
    const row = (
      await this.db.query(
        `SELECT p.id,p.task_id AS "taskId",p.node_id AS "nodeId",p.save_status AS "saveStatus",
       coalesce(bool_and(s.closure_verified),false) AS closed
       FROM pr_node_profiles p LEFT JOIN pr_executions e ON e.task_id=p.task_id
       LEFT JOIN pr_sessions s ON s.execution_id=e.id WHERE p.id=$1 GROUP BY p.id`,
        [id],
      )
    ).rows[0];
    if (!row)
      throw new ApiError(404, 'NODE_PROFILE_MISSING', '历史模板会话不存在');
    return row;
  }

  /** 旧链接仍可关闭遗留会话；不等待、不续租、不发布模板。 */
  async close(id: string) {
    const row = await this.status(id);
    await this.tasks.cancel(row.taskId);
  }
}
