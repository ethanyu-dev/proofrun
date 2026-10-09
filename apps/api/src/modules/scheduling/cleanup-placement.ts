import type { QueueReason, VerificationTask } from '@proofrun/contracts';
import type { PoolClient } from 'pg';

/** 清理只能沿用所属主任务的实际执行节点，不能借用同批其他 case 的归属。 */
interface CleanupPlacement {
  /** 已核实主任务终止且原会话关闭后，唯一允许分配清理的节点。 */
  requiredNode?: string;
  /** 缺失关联、前置条件未满足或配置冲突时保留排队，禁止改派。 */
  blocked?: QueueReason['code'];
}

/** 创建清理时的检查不能替代领取检查；兼容升级前已经排队的清理记录。 */
export async function cleanupPlacement(
  client: PoolClient,
  task: VerificationTask,
  routedNode: string | undefined,
): Promise<CleanupPlacement> {
  if (task.purpose !== 'cleanup') return {};
  const parent = (
    await client.query<{
      state: string;
      node_ids: string[];
      closed: boolean;
    }>(
      `SELECT p.state,
        coalesce(array_agg(DISTINCT s.node_id) FILTER (WHERE s.node_id IS NOT NULL),ARRAY[]::text[]) AS node_ids,
        coalesce(bool_and(coalesce(s.closure_verified,false)),false) AS closed
      FROM pr_case_cleanups c JOIN pr_tasks p ON p.id=c.parent_task_id
      LEFT JOIN pr_executions e ON e.task_id=p.id
      LEFT JOIN pr_sessions s ON s.execution_id=e.id
      WHERE c.task_id=$1 AND c.parent_task_id=$2 AND c.state<>'SKIPPED'
      GROUP BY p.id`,
      [task.taskId, task.parentTaskId],
    )
  ).rows[0];
  if (!parent) return { blocked: 'CLEANUP_PARENT_MISSING' };
  if (['QUEUED', 'RUNNING'].includes(parent.state))
    return { blocked: 'CLEANUP_PARENT_PENDING' };
  // 没有执行记录就没有可证明的清理节点，不能随机选择一台机器。
  const nodeId = parent.node_ids[0];
  if (parent.node_ids.length !== 1 || !nodeId)
    return { blocked: 'CLEANUP_PARENT_MISSING' };
  if (!parent.closed) return { blocked: 'CLEANUP_PARENT_PENDING' };
  if (
    (routedNode && routedNode !== nodeId) ||
    (task.environment.auth && task.environment.auth.nodeId !== nodeId)
  )
    return { blocked: 'CLEANUP_NODE_CONFLICT' };
  return { requiredNode: nodeId };
}
