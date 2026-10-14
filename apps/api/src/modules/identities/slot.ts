import type { SessionPlan, VerificationTask } from '@proofrun/contracts';
import { digest } from '../../domain.js';

/** 未选择账号的任务也预留稳定内部槽；实际发生成功 HITL 后才公开为身份。 */
export function fallbackLibraryIdentity(
  task: VerificationTask,
): SessionPlan['candidates'][number] {
  const hash = digest(task.comparison?.id ?? task.taskId);
  const uuid = (value: string) =>
    `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
  const id = uuid(hash.slice(0, 32));
  return {
    id,
    accountKey: id,
    libraryVersion: uuid(hash.slice(32)),
    label: `人工准备 · ${new URL(task.target.url).hostname}`,
    url: task.target.url,
    origins: [new URL(task.target.url).origin],
    description: task.objective.slice(0, 2000),
    maxConcurrent: 1,
    checks: [],
  };
}
