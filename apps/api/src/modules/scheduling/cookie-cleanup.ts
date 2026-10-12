import type { PoolClient } from 'pg';
import type { NodeCommand, StepResult } from '@proofrun/contracts';
import { ApiError } from '../../domain.js';
import type { ExecutionContext } from './state.js';

/** Cookie 名字以完整 ASCII token 匹配清理原文（引号和反引号作为书写分隔符），避免子串误删其他身份。 */
const COOKIE_NAME = /[A-Za-z0-9!#$%&*+.^_|~-]+/g;

/** 在原执行事务里核实清理阶段、固定 origin、明确名字和节点能力，再允许派发。 */
export async function authorizeCookieCleanup(
  client: PoolClient,
  context: ExecutionContext,
  operation: Extract<NodeCommand['command'], { type: 'browser.cookies.clear' }>,
  actor: 'AGENT' | 'HUMAN',
): Promise<void> {
  const steps = (
    await client.query('SELECT step_results FROM pr_tasks WHERE id=$1', [
      context.task_id,
    ])
  ).rows[0]?.step_results as StepResult[] | null;
  const active = steps?.find((step) => step.status === 'RUNNING');
  const definition = context.definition.steps?.find(
    (step) => step.stepId === active?.stepId,
  );
  const names: string[] = definition?.description.match(COOKIE_NAME) ?? [];
  const url = new URL(operation.url);
  if (
    actor !== 'AGENT' ||
    !active ||
    !context.definition.cleanupStepIds?.includes(active.stepId) ||
    !definition ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.origin !== new URL(definition.url).origin ||
    operation.names.some((name) => name === '*' || !names.includes(name))
  )
    throw new ApiError(
      403,
      'COOKIE_CLEANUP_FORBIDDEN',
      '只能在后续清理中删除该步骤原文指定的 Cookie 名字',
    );
  const node = (
    await client.query('SELECT capabilities FROM pr_nodes WHERE id=$1', [
      context.node_id,
    ])
  ).rows[0];
  if (node?.capabilities?.cookieCleanup !== true)
    throw new ApiError(
      409,
      'COOKIE_CLEANUP_UNSUPPORTED',
      '当前节点尚未支持指定 Cookie 清理，需要升级节点',
    );
}
