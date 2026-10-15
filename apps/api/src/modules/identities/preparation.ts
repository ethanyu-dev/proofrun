import type { PoolClient } from 'pg';
import type { NodeCommand, SessionPlan } from '@proofrun/contracts';
import { ApiError, canonical } from '../../domain.js';
import type { ExecutionContext } from '../scheduling/state.js';

/** 登录准备仅在业务步骤开始前执行一次；幂等重送由上层命令 ID 处理。 */
export async function authorizePreparation(
  client: PoolClient,
  context: ExecutionContext,
  operation: Extract<
    NodeCommand['command'],
    { type: 'browser.identity.prepare' }
  >,
): Promise<number> {
  const plan = context.definition.sessionPlan;
  const identity = (
    await client.query<{ identity: SessionPlan['candidates'][number] }>(
      'SELECT identity FROM pr_identity_assignments WHERE task_id=$1',
      [context.task_id],
    )
  ).rows[0]?.identity;
  if (
    !plan ||
    !identity ||
    context.budget_state?.stepId ||
    operation.url !== context.definition.target.url ||
    operation.profileRef !== identity.loginRef
  )
    throw new ApiError(
      403,
      'IDENTITY_PREPARATION_FORBIDDEN',
      '登录准备必须绑定本次分配的身份，且先于业务步骤',
    );
  const checks = [...identity.checks, ...plan.requirements];
  const automatic = checks
    .filter((c) => c.method !== 'manual')
    .map((c) => ({ method: c.method, value: c.value }));
  if (
    canonical(operation.checks) !== canonical(automatic) ||
    operation.saveSnapshot !==
      (!plan.library && checks.every((c) => c.method !== 'manual'))
  )
    throw new ApiError(
      403,
      'IDENTITY_CHECK_CONFLICT',
      '登录核验必须采用冻结条件',
    );
  if (
    (
      await client.query(
        "SELECT 1 FROM pr_commands WHERE execution_id=$1 AND kind='browser.identity.prepare'",
        [context.id],
      )
    ).rowCount
  )
    throw new ApiError(
      409,
      'IDENTITY_PREPARATION_EXHAUSTED',
      '本次自动登录已尝试，不能重复提交登录',
    );
  return plan.preparationMs;
}
