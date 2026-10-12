import type { NodeCommand, VerificationTask } from '@proofrun/contracts';
import { digest } from '../../domain.js';

/** 节点协议中的槽位配置；快照内容不会进入控制面或模型上下文。 */
export type SessionAuth = NonNullable<
  Extract<NodeCommand['command'], { type: 'session.open' }>['authState']
>;

/** 自动槽位按环境、资源池与站点隔离；显式槽位保留调用者指定的名称。 */
export function sessionAuth(task: VerificationTask): SessionAuth | null {
  if (task.sessionPlan) {
    if (task.sessionPlan.mode === 'guest') return null;
    const identity = task.sessionPlan.candidates[0];
    if (identity)
      return {
        stateId:
          identity.stateId ??
          `identity-${digest(JSON.stringify([task.environment.id, identity.id, new URL(task.target.url).origin]))}`,
        restore: true,
        restoreIfPresent: true,
        snapshotId: digest(task.comparison?.id ?? task.taskId),
      };
    // 未指定身份的 v2 沿用本站复用规则；明确关闭复用时仅保存本轮人工登录，不读写共享账号。
    if (
      !task.environment.auth &&
      !(task.environment.reuseAuth ?? task.environment.allowIntervention)
    )
      return {
        stateId: `identity-${digest(task.comparison?.id ?? task.taskId)}`,
        restore: false,
        restoreIfPresent: true,
        snapshotId: digest(task.comparison?.id ?? task.taskId),
      };
  }
  const auth = task.environment.auth;
  if (
    !auth &&
    !(task.environment.reuseAuth ?? task.environment.allowIntervention)
  )
    return null;
  return {
    stateId:
      auth?.stateId ??
      `auto-${digest(
        JSON.stringify([
          task.environment.id,
          task.environment.nodePool,
          new URL(task.target.url).origin,
        ]),
      )}`,
    restore: auth?.restore ?? true,
    restoreIfPresent: !auth,
    snapshotId: digest(task.comparison?.id ?? task.taskId),
  };
}
