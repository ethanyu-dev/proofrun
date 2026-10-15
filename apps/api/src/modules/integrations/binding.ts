import type { PoolClient } from 'pg';
import type { IntegrationSubmit, VerificationTask } from '@proofrun/contracts';
import { ApiError, canonical, digest } from '../../domain.js';
import { caseArmIds } from '../cases/structured.js';

/** 仅保存可审计的来源和路由身份；服务令牌由进程配置提供。 */
export interface CaseBindingContext {
  /** 服务连接身份；运行时凭据不在此快照中。 */
  integrationId: string;
  /** 由 cc-connect 解析为机器人与群的稳定引用。 */
  bindingRef: string;
  /** 首次接收时确认的路由版本。 */
  bindingVersion: number;
  /** 已排序的订阅集合，人工事件始终订阅。 */
  events: Array<'hitl' | 'case.finished'>;
  /** 上游追踪信息，不作为授权依据。 */
  source?: IntegrationSubmit['source'];
  /** 规范化原始 case 的摘要，用于不可变身份检查。 */
  definitionDigest: string;
}
/** 调度事务在持有 case 身份锁后写入；deduplicated 是提交完成后返回的真实判定。 */
export interface CaseBindingWrite {
  /** 绑定该 case 的客户端身份。 */
  clientId: string;
  /** 不含秘密的冻结上下文。 */
  context: CaseBindingContext;
  /** 调度事务持锁后回写，避免并发请求均宣称首次创建。 */
  deduplicated: boolean;
}
/** 拒绝从管理入口接管历史 case；绑定和任务一起成功或一起回滚。 */
export async function bindIntegratedCase(
  client: PoolClient,
  task: VerificationTask,
  binding: CaseBindingWrite,
  existing: boolean,
): Promise<void> {
  const row = (
    await client.query(
      'SELECT client_id,context FROM pr_integration_cases WHERE case_id=$1',
      [task.caseV2Definition!.caseId],
    )
  ).rows[0];
  if (existing) {
    if (
      !row ||
      row.client_id !== binding.clientId ||
      canonical(row.context) !== canonical(binding.context)
    )
      throw new ApiError(
        409,
        'CASE_BINDING_CONFLICT',
        'Case 已绑定另一调用者、来源或通知路由',
      );
    binding.deduplicated = true;
    return;
  }
  if (
    binding.context.definitionDigest !==
    digest(canonical(task.caseV2Definition))
  )
    throw new ApiError(409, 'CASE_CONFLICT', 'Case 定义摘要不一致');
  binding.deduplicated = false;
  await client.query(
    'INSERT INTO pr_integration_cases(case_id,task_id,task_ids,client_id,context) VALUES($1,$2,$3,$4,$5)',
    [
      task.caseV2Definition!.caseId,
      task.taskId,
      caseArmIds(task),
      binding.clientId,
      binding.context,
    ],
  );
}
