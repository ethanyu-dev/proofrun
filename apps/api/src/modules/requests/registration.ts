import type { PoolClient } from 'pg';
import type { VerificationTask } from '@proofrun/contracts';
import { ApiError, canonical, digest } from '../../domain.js';

/** 已由入口校验的请求身份；不参与任何 case 定义哈希。 */
export interface RequestRegistration {
  /** 一次逻辑提交的稳定身份。 */
  requestId: string;
  /** 首次接收冻结的标题。 */
  title: string;
  /** 不受成员排列影响的请求定义摘要。 */
  hash: string;
  /** 重跑只允许新建目标，来源映射随同成员一起冻结。 */
  sourceRequestId?: string;
  /** 新 case 身份映射到原 case，不改变旧成员关系。 */
  sources?: Record<string, string>;
  /** 保存完整重跑选择供溯源，不参与调度状态更新。 */
  rerunParameters?: unknown;
}

/** 在 case 锁之前获取请求锁；重试只返回原成员，不覆盖已有归属。 */
export async function registerRequest(
  client: PoolClient,
  request: RequestRegistration,
): Promise<boolean> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `request:${request.requestId}`,
  ]);
  const existing = (
    await client.query(
      'SELECT definition_hash FROM pr_verification_requests WHERE request_id=$1',
      [request.requestId],
    )
  ).rows[0];
  if (existing) {
    if (existing.definition_hash !== request.hash)
      throw new ApiError(
        409,
        'REQUEST_CONFLICT',
        'requestId 已绑定另一份请求定义',
      );
    return false;
  }
  await client.query(
    `INSERT INTO pr_verification_requests(request_id,title,definition_hash,source_request_id,rerun_parameters) VALUES($1,$2,$3,$4,$5)`,
    [
      request.requestId,
      request.title,
      request.hash,
      request.sourceRequestId ?? null,
      request.rerunParameters ?? null,
    ],
  );
  return true;
}

/** 从事务内已落库的定义提取实际执行组，避免并发配置变动造成错误归属。 */
export async function registerMembers(
  client: PoolClient,
  request: RequestRegistration,
  tasks: VerificationTask[],
  created: Set<string>,
) {
  for (const [position, candidate] of tasks.entries()) {
    const definition = (
      await client.query('SELECT definition FROM pr_tasks WHERE id=$1', [
        candidate.taskId,
      ])
    ).rows[0].definition as VerificationTask;
    const caseId = definition.caseV2Definition!.caseId;
    await client.query(
      `INSERT INTO pr_verification_request_cases(request_id,case_id,task_id,position,definition_hash,execution_origin,source_case_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        request.requestId,
        caseId,
        definition.taskId,
        position,
        digest(canonical(definition.caseV2Definition)),
        created.has(definition.taskId) ? 'created' : 'reused',
        request.sources?.[caseId] ?? null,
      ],
    );
    if (definition.comparison) {
      const siblingId = `comparison-${definition.comparison.sourceTaskId ?? definition.taskId}-jev`;
      const sibling = (
        await client.query('SELECT id FROM pr_tasks WHERE id=$1', [siblingId])
      ).rows[0];
      if (!sibling)
        throw new ApiError(409, 'CASE_INCOMPLETE', '历史双跑执行组记录不完整');
      await client.query(
        `INSERT INTO pr_verification_request_arms(request_id,case_id,execution_mode,task_id) VALUES($1,$2,'jev',$3)`,
        [request.requestId, caseId, siblingId],
      );
    }
  }
}
