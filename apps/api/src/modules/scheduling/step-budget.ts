import { stepLimit, type StepResult } from '@proofrun/contracts';
import type { PoolClient } from 'pg';
import { ApiError } from '../../domain.js';
import type { ExecutionContext } from './state.js';

/** 控制面持有的额度游标，不能由 worker 的用量或 startedAt 反向覆盖。 */
export interface BudgetState {
  /** 清理步骤之间切换身份，但不能重置整段清理的计数或期限。 */
  stepId: string;
  /** 已准入的自动动作，明确拒绝和幂等重送不计数。 */
  actions: number;
  /** 派发前已登记的模型请求；失败请求也占用额度。 */
  modelCalls: number;
  /** 服务端毫秒时间戳，到期只阻止本步新操作，不撤销整个执行。 */
  deadlineAt: number;
  /** 业务人工等待起点；清理不设置暂停点。 */
  pausedAt: number | null;
}

/** 首次进入某一步才签发期限；重复快照不能加时，已结束步骤不能重新开始。 */
export async function startStepBudget(
  client: PoolClient,
  context: ExecutionContext,
  results: StepResult[],
) {
  if (!context.definition.stepBudget) return;
  const running = results.find((step) => step.status === 'RUNNING');
  if (!running || context.budget_state?.stepId === running.stepId) return;
  if (context.control_mode !== 'AUTO')
    throw new ApiError(409, 'CONTROL_CHANGED', '人工处理期间不能开始下一步');
  const previous = (
    await client.query('SELECT step_results FROM pr_tasks WHERE id=$1', [
      context.task_id,
    ])
  ).rows[0]?.step_results as StepResult[] | null;
  if (
    previous?.some(
      (step) => step.stepId === running.stepId && step.status !== 'PENDING',
    )
  )
    throw new ApiError(422, 'INVALID_STEPS', '已开始的步骤不能重置预算');
  const pending = await client.query(
    "SELECT 1 FROM pr_commands WHERE execution_id=$1 AND kind LIKE 'browser.%' AND result IS NULL",
    [context.id],
  );
  if (pending.rowCount)
    throw new ApiError(409, 'SESSION_BUSY', '当前命令尚未确定，不能切换步骤');
  const modelPending = await client.query(
    "SELECT 1 FROM pr_model_calls WHERE execution_id=$1 AND record->>'status'='PENDING'",
    [context.id],
  );
  if (modelPending.rowCount)
    throw new ApiError(
      409,
      'MODEL_CALL_PENDING',
      '模型请求尚未交付回执，不能切换步骤',
    );
  const limit = stepLimit(context.definition, running.stepId);
  if (!limit)
    throw new ApiError(422, 'INVALID_STEP_BUDGET', '步骤缺少冻结预算');
  const cleanup = context.definition.cleanupStepIds ?? [];
  const sharingCleanup =
    context.budget_state &&
    cleanup.includes(context.budget_state.stepId) &&
    cleanup.includes(running.stepId);
  context.budget_state = sharingCleanup
    ? { ...context.budget_state!, stepId: running.stepId }
    : {
        stepId: running.stepId,
        actions: 0,
        modelCalls: 0,
        deadlineAt:
          context.cleanup_deadline_at?.getTime() ??
          Date.now() + limit.timeoutMs,
        pausedAt: null,
      };
  await saveBudget(client, context);
}

/** 模型请求和动作均在去重后原子计数；失败调用也已占用额度，不回退。 */
export async function consumeStepBudget(
  client: PoolClient,
  context: ExecutionContext,
  kind: 'actions' | 'modelCalls' | 'observe',
) {
  if (!context.definition.stepBudget) return;
  const state = context.budget_state;
  const limit = state && stepLimit(context.definition, state.stepId);
  if (!state || !limit)
    throw new ApiError(409, 'STEP_NOT_STARTED', '先登记当前步骤，再执行操作');
  if (context.control_mode !== 'AUTO')
    throw new ApiError(409, 'CONTROL_CHANGED', '自动执行已暂停');
  const active = await client.query(
    "SELECT 1 FROM pr_tasks WHERE id=$1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(step_results) step WHERE step->>'stepId'=$2 AND step->>'status'='RUNNING')",
    [context.task_id, state.stepId],
  );
  if (!active.rowCount)
    throw new ApiError(409, 'STEP_NOT_STARTED', '当前步骤已结束，不能追加请求');
  if (state.deadlineAt <= Date.now())
    throw new ApiError(
      409,
      'STEP_TIME_BUDGET_EXCEEDED',
      '本步骤时间预算已耗尽，继续后续步骤',
    );
  if (kind === 'observe') return;
  const maximum = kind === 'actions' ? limit.maxActions : limit.maxModelCalls;
  if (state[kind] >= maximum)
    throw new ApiError(
      409,
      kind === 'actions'
        ? 'STEP_ACTION_BUDGET_EXCEEDED'
        : 'STEP_MODEL_BUDGET_EXCEEDED',
      `本步骤${kind === 'actions' ? '动作' : '模型请求'}预算已耗尽（${state[kind]}/${maximum}）`,
    );
  state[kind]++;
  await saveBudget(client, context);
}

/** 暂停只补回实际人工等待时间；重复恢复由控制代次去重，清理墙钟始终不暂停。 */
export async function pauseStepBudget(
  client: PoolClient,
  context: ExecutionContext,
  action: 'request' | 'acknowledge' | 'resume',
) {
  if (!context.definition.stepBudget || context.cleanup_deadline_at) return;
  const state = (context.budget_state ??= {
    stepId: '',
    actions: 0,
    modelCalls: 0,
    deadlineAt: context.deadline_at.getTime(),
    pausedAt: null,
  });
  if (action === 'request') state.pausedAt ??= Date.now();
  if (action === 'resume' && state.pausedAt !== null) {
    const elapsed = Math.max(0, Date.now() - state.pausedAt);
    state.deadlineAt += elapsed;
    state.pausedAt = null;
    context.deadline_at = new Date(context.deadline_at.getTime() + elapsed);
    await client.query('UPDATE pr_tasks SET deadline_at=$2 WHERE id=$1', [
      context.task_id,
      context.deadline_at,
    ]);
  }
  await saveBudget(client, context);
}

/** 与执行事务共同提交，防止并发动作绕过计数。 */
async function saveBudget(client: PoolClient, context: ExecutionContext) {
  await client.query('UPDATE pr_executions SET budget_state=$2 WHERE id=$1', [
    context.id,
    JSON.stringify(context.budget_state),
  ]);
}
