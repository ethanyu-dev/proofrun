import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { SessionPlan, VerificationTask } from '@proofrun/contracts';
import type { Database } from '../../db.js';
import { ApiError } from '../../domain.js';

/** 模型选择租约独立于浏览器资源；超时后另一个 worker 可以接替。 */
const SELECTION_LEASE_MS = 120_000;
/** 同轮对照共享选择，业务组只改变执行策略。 */
export const selectionScope = (task: VerificationTask) =>
  task.comparison?.id ?? task.taskId;

/** 原任务定义保持不可变，运行时将已选计划投影到授权上下文。 */
export async function selectedTask(
  client: PoolClient,
  task: VerificationTask,
): Promise<VerificationTask | null> {
  if (task.sessionPlan?.selection !== 'pending') return task;
  const row = (
    await client.query<{ plan: SessionPlan | null }>(
      'SELECT plan FROM pr_identity_selections WHERE scope=$1',
      [selectionScope(task)],
    )
  ).rows[0];
  return row?.plan ? { ...task, sessionPlan: row.plan } : null;
}

/** 只向身份 Agent 提供候选摘要；凭据和节点文件位置从不进入选择请求。 */
export class IdentitySelection {
  constructor(private readonly db: Database) {}
  async claim() {
    return this.db.transaction(async (client) => {
      // 冻结定义始终保留 pending；必须在 LIMIT 前排除已完成选择和活动租约，避免队尾饥饿。
      const tasks = await client.query<{ definition: VerificationTask }>(
        `SELECT t.definition FROM pr_tasks t
        LEFT JOIN pr_identity_selections s ON s.scope=COALESCE(t.definition#>>'{comparison,id}',t.id)
        WHERE t.state='QUEUED' AND t.deadline_at>clock_timestamp()
          AND t.definition#>>'{sessionPlan,selection}'='pending'
          AND (s.scope IS NULL OR (s.plan IS NULL AND s.expires_at<clock_timestamp()))
        ORDER BY t.created_at,t.id LIMIT 64`,
      );
      for (const { definition: task } of tasks.rows) {
        const token = randomUUID();
        const reserved = await client.query(
          `INSERT INTO pr_identity_selections(scope,claim_token,expires_at) VALUES($1,$2,clock_timestamp()+$3*interval '1 millisecond') ON CONFLICT(scope) DO UPDATE SET claim_token=$2,expires_at=EXCLUDED.expires_at WHERE pr_identity_selections.plan IS NULL AND pr_identity_selections.expires_at<clock_timestamp() RETURNING scope`,
          [selectionScope(task), token, SELECTION_LEASE_MS],
        );
        if (!reserved.rowCount) continue;
        return {
          selection: {
            taskId: task.taskId,
            token,
            task: {
              objective: task.objective,
              url: task.target.url,
              steps: task.steps?.map((step) => ({
                description: step.description,
                policy: step.policy,
                type: step.type,
              })),
            },
            candidates: task.sessionPlan!.candidates.map((identity) => ({
              id: identity.id,
              name: identity.label,
              type: identity.identityType ?? '',
              description: identity.description ?? '',
              url: identity.url ?? identity.origins[0],
            })),
          },
        };
      }
      return { selection: null };
    });
  }
  /** 模型只能选择冻结候选；未知引用、过期选择以及任意额外参数都不能分配账号。 */
  async finish(raw: unknown) {
    const input = raw as {
      taskId: string;
      token: string;
      identityId: string | null;
      needsIdentity: boolean;
      reason: string;
    };
    if (
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).some(
        (k) =>
          ![
            'taskId',
            'token',
            'identityId',
            'needsIdentity',
            'reason',
          ].includes(k),
      ) ||
      typeof input.taskId !== 'string' ||
      typeof input.token !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(input.token) ||
      (input.identityId !== null && typeof input.identityId !== 'string') ||
      typeof input.needsIdentity !== 'boolean' ||
      typeof input.reason !== 'string' ||
      !input.reason.trim() ||
      input.reason.length > 1000
    )
      throw new ApiError(422, 'INVALID_IDENTITY_SELECTION', '身份选择格式无效');
    return this.db.transaction(async (client) => {
      const row = (
        await client.query<{ definition: VerificationTask; state: string }>(
          'SELECT definition,state FROM pr_tasks WHERE id=$1 FOR UPDATE',
          [input.taskId],
        )
      ).rows[0];
      if (!row || row.definition.sessionPlan?.selection !== 'pending')
        throw new ApiError(
          409,
          'IDENTITY_SELECTION_CHANGED',
          '任务不再等待身份选择',
        );
      const task = row.definition;
      const selection = (
        await client.query<{
          claim_token: string;
          expires_at: Date;
          plan: SessionPlan | null;
        }>('SELECT * FROM pr_identity_selections WHERE scope=$1 FOR UPDATE', [
          selectionScope(task),
        ])
      ).rows[0];
      if (selection?.plan && selection.claim_token === input.token)
        return { selected: true };
      if (
        row.state !== 'QUEUED' ||
        !selection ||
        selection.claim_token !== input.token ||
        selection.expires_at.getTime() <= Date.now()
      )
        throw new ApiError(409, 'IDENTITY_SELECTION_CHANGED', '身份选择已过期');
      const identity = task.sessionPlan!.candidates.find(
        (item) => item.id === input.identityId,
      );
      if (input.identityId && (!identity || !input.needsIdentity))
        throw new ApiError(
          422,
          'INVALID_IDENTITY_SELECTION',
          '只能选择本次候选身份',
        );
      const human = !identity && input.needsIdentity;
      // 无合适账号时预留一个待人工准备的内部身份；成功交还后才加入公共身份库。
      const pendingId = randomUUID();
      const candidates: SessionPlan['candidates'] = identity
        ? [identity]
        : human
          ? [
              {
                id: pendingId,
                accountKey: pendingId,
                label: `人工准备 · ${new URL(task.target.url).hostname}`,
                origins: [new URL(task.target.url).origin],
                url: task.target.url,
                description: task.objective.slice(0, 2000),
                maxConcurrent: 1,
                checks: [],
                libraryVersion: randomUUID(),
              },
            ]
          : [];
      const plan: SessionPlan = {
        ...task.sessionPlan!,
        mode: candidates.length ? 'identity' : 'manual',
        candidates,
        selection: human ? 'human' : 'selected',
        selectionReason: input.reason.trim(),
      };
      await client.query(
        'UPDATE pr_identity_selections SET plan=$2,selected_at=clock_timestamp() WHERE scope=$1',
        [selectionScope(task), plan],
      );
      return { selected: true };
    });
  }
}
