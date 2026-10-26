import type { PoolClient } from 'pg';
import type { VerificationTask } from '@proofrun/contracts';
import { ApiError } from '../../domain.js';
import type { RequestRegistration } from './registration.js';

/** 调用方已持请求锁；记录与入队同事务提交，失败或冲突时整批回滚。 */
export async function registerRerun(
  client: PoolClient,
  request: RequestRegistration,
): Promise<boolean> {
  const existing = await client.query(
    'SELECT request_id FROM pr_verification_requests WHERE request_id=$1 AND deleted_at IS NULL FOR UPDATE',
    [request.requestId],
  );
  if (!existing.rowCount)
    throw new ApiError(404, 'REQUEST_MISSING', '请求不存在');
  const accepted = await client.query(
    `INSERT INTO pr_request_reruns(request_id,definition_hash,parameters) VALUES($1,$2,$3)
     ON CONFLICT DO NOTHING RETURNING request_id`,
    [request.requestId, request.hash, request.rerunParameters],
  );
  if (!accepted.rowCount) return false;
  return true;
}

/** 只切换本请求的选定成员；旧任务和证据仍可通过 case 运行历史访问。 */
export async function replaceMemberRuns(
  client: PoolClient,
  request: RequestRegistration,
  tasks: VerificationTask[],
) {
  for (const task of tasks) {
    const caseId = task.caseV2Definition!.caseId;
    const changed = await client.query(
      `UPDATE pr_verification_request_cases c SET task_id=$3,execution_origin='created'
       WHERE request_id=$1 AND case_id=$2
       AND EXISTS(SELECT 1 FROM pr_tasks t WHERE t.id=c.task_id AND t.deleted_at IS NULL)
       RETURNING case_id`,
      [request.requestId, caseId, task.taskId],
    );
    if (!changed.rowCount)
      throw new ApiError(
        409,
        'CASE_MISSING',
        '请求成员已删除或不存在，请刷新后重试',
      );
    // 历史双跑从组不能混入新一轮单 LLM 结果；其原任务不删除。
    await client.query(
      'DELETE FROM pr_verification_request_arms WHERE request_id=$1 AND case_id=$2',
      [request.requestId, caseId],
    );
  }
}
