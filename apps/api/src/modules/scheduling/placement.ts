import type { QueueReason, VerificationTask } from '@proofrun/contracts';
import type { PoolClient } from 'pg';
import { sessionAuth, type SessionAuth } from './auth.js';

/** 对外诊断仅使用固定说明，不泄露节点身份、登录槽名称或业务数据。 */
const QUEUE_MESSAGES: Record<QueueReason['code'], string> = {
  CLEANUP_PARENT_PENDING:
    '等待所属 case 结束并确认原浏览器会话关闭后执行清理。',
  CLEANUP_PARENT_MISSING:
    '无法核实清理与所属 case 的执行节点关联，停止分配清理。',
  CLEANUP_NODE_CONFLICT:
    '清理必须沿用所属 case 的执行节点，但当前路由或显式登录节点与其冲突。',
  AUTH_NODE_ROUTE_CONFLICT:
    '显式登录节点与域名路由不一致，请调整执行配置或路由。',
  COMPARISON_NODE_CONFLICT:
    '本轮对照已固定初始登录快照节点，与当前路由或登录节点冲突；请恢复配置或新建对照。',
  RESOURCE_BUSY: '关联任务或清理尚未完成，正在等待当前任务上下文释放。',
  NO_ELIGIBLE_NODE:
    '当前没有满足路由、显式登录节点、快照归属及所需能力的在线节点。',
  NODE_CAPACITY: '符合条件的节点容量已满，正在等待浏览器会话释放。',
  NODE_ROTATING: '符合条件的节点正在轮换凭据，暂时不能领取任务。',
};

/** 相同原因不重复写库；该诊断只能由仍处于排队状态的任务更新。 */
export async function recordQueueReason(
  client: PoolClient,
  taskId: string,
  code: QueueReason['code'],
): Promise<void> {
  const reason: QueueReason = { code, message: QUEUE_MESSAGES[code] };
  await client.query(
    "UPDATE pr_tasks SET queue_reason=$2 WHERE id=$1 AND state='QUEUED' AND queue_reason IS DISTINCT FROM $2::jsonb",
    [taskId, reason],
  );
}

/** 自动归属是偏好；只有显式节点和已开始的同轮快照属于硬约束。 */
interface AuthPlacement {
  /** 下发节点的恢复规则；自动模式只恢复所选节点上已有的状态。 */
  auth: SessionAuth | null;
  /** 自动槽位最近一次成功分配的节点，缺失或不可用时允许选择其他节点。 */
  preferredNode?: string | undefined;
  /** 显式指定或本轮对照已选定的节点，不能静默回退。 */
  requiredNode?: string | undefined;
  /** 冲突不生成执行，保留可恢复的排队状态与明确诊断。 */
  conflict?: QueueReason['code'];
}

/** 在领取事务内计算约束；锁繁忙返回 null，让其他 worker 完成当前选择。 */
export async function authPlacement(
  client: PoolClient,
  task: VerificationTask,
  routedNode: string | undefined,
): Promise<AuthPlacement | null> {
  const auth = sessionAuth(task);
  const placement: AuthPlacement = {
    auth,
    requiredNode: task.environment.auth?.nodeId,
  };
  if (
    routedNode &&
    placement.requiredNode &&
    routedNode !== placement.requiredNode
  ) {
    placement.conflict = 'AUTH_NODE_ROUTE_CONFLICT';
    return placement;
  }
  if (!auth) return placement;
  if (!task.environment.auth) {
    // 同一自动槽位的短事务串行，保持偏好更新一致；不要求浏览器执行串行。
    const lock = await client.query(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 1)) AS locked',
      [auth.stateId],
    );
    if (!lock.rows[0].locked) return null;
    placement.preferredNode = (
      await client.query<{ node_id: string }>(
        'SELECT node_id FROM pr_auth_bindings WHERE scope=$1',
        [auth.stateId],
      )
    ).rows[0]?.node_id;
  }
  if (task.comparison) {
    // 快照文件只在节点本机；另一组即使尚未领取，也必须沿用本轮首次分配的节点。
    const lock = await client.query(
      'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 3)) AS locked',
      [task.comparison.id],
    );
    if (!lock.rows[0].locked) return null;
    const pinned = await client.query<{ node_id: string }>(
      'SELECT DISTINCT s.node_id FROM pr_executions e JOIN pr_sessions s ON s.execution_id=e.id WHERE e.task_id=ANY($1::text[])',
      [['llm', 'jev'].map((arm) => `${task.comparison!.id}-${arm}`)],
    );
    const nodeId = pinned.rows[0]?.node_id;
    if (
      pinned.rows.length > 1 ||
      (nodeId &&
        ((routedNode && nodeId !== routedNode) ||
          (placement.requiredNode && nodeId !== placement.requiredNode)))
    ) {
      placement.conflict = 'COMPARISON_NODE_CONFLICT';
    } else if (nodeId) {
      placement.requiredNode = nodeId;
    }
  }
  return placement;
}
