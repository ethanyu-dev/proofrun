import type { QueueReason, VerificationTask } from '@proofrun/contracts';
import type { PoolClient } from 'pg';

/** 对外诊断仅使用固定说明，不泄露节点身份、登录槽名称或业务数据。 */
const QUEUE_MESSAGES: Record<QueueReason['code'], string> = {
  EXTERNAL_ACCOUNT_WAIT:
    '等待 DevPass 账号分配与材料准备，具体原因见身份详情。',
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
  IDENTITY_BUSY: '符合条件的测试账号正在使用中，等待会话清理完成。',
  IDENTITY_UNAVAILABLE:
    '本地测试身份已移除，请用 DevPass 或人工会话配置重新提交。',
  RESOURCE_BUSY: '关联任务或清理尚未完成，正在等待当前任务上下文释放。',
  NO_ELIGIBLE_NODE: '当前没有满足路由、指定身份节点及所需能力的在线节点。',
  SESSION_BUDGET_UNSUPPORTED:
    '在线节点的最长会话时限不足以覆盖全部步骤、操作收尾和后续清理，请拆分 case 或提高节点会话能力。',
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

/** 只保留显式身份节点与路由约束，不维护登录槽的节点偏好。 */
export function identityPlacement(
  task: VerificationTask,
  routedNode: string | undefined,
): {
  /** 指定身份可要求节点本机的私有凭据。 */
  requiredNode?: string | undefined;
  /** 路由冲突明确排队，不能换节点绕过指定身份。 */
  conflict?: QueueReason['code'];
} {
  const requiredNode = task.environment.auth?.nodeId;
  return {
    requiredNode,
    ...(routedNode && requiredNode && routedNode !== requiredNode
      ? { conflict: 'AUTH_NODE_ROUTE_CONFLICT' as const }
      : {}),
  };
}
