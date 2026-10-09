import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { NodeCommand, VerificationTask } from '@proofrun/contracts';
import {
  ApiError,
  canonical,
  digest,
  type CommandResult,
} from '../../domain.js';

/** 清理命令有独立期限，不随原浏览器操作的超时一同取消。 */
const CLOSE_TIMEOUT_MS = 15_000;

/** 一次执行的锁定视图；包含任务预算、执行者权限和浏览器资源三组独立状态。 */
export interface ExecutionContext {
  /** 平台分配的一次执行身份。 */
  id: string;
  /** 上层任务身份；首版每个任务只有一次执行。 */
  task_id: string;
  /** 准入时冻结的完整定义，执行者不能改写标准。 */
  definition: VerificationTask;
  /** 是否允许继续业务执行；与物理清理进度独立。 */
  task_state: string;
  /** 自动执行的截止时间；人工暂停期间不生效，恢复后重置。 */
  deadline_at: Date;
  /** 本次执行令牌摘要，不能用全局 worker 凭据代替。 */
  token_hash: string;
  /** worker 权限期限，节点心跳不能延长它。 */
  lease_expires_at: Date;
  /** worker 执行和资源停止阶段。 */
  execution_state: string;
  /** 已准入的写动作数，重复命令不重复计数。 */
  action_count: number;
  /** 自动与人工操作互斥，代次绑定当前观察。 */
  control_mode: 'AUTO' | 'REQUESTED' | 'HUMAN';
  control_revision: number;
  control_reason: string | null;
  /** 会话创建后身份不可复用。 */
  session_id: string;
  /** 本机浏览器资源的创建、活动、清理或隔离状态。 */
  session_state: string;
  /** 会话绑定的节点安装身份。 */
  node_id: string;
  /** 会话绑定的节点进程身份，重启后旧动作不能继续。 */
  node_epoch: string;
  /** 原会话授权身份，结束后仍用于匹配清理。 */
  lease_id: string;
  /** PostgreSQL bigint 以字符串读取，发送前在安全整数范围内转换。 */
  fence: string;
  /** 只有核实关闭或确认创建前拒绝才允许释放容量。 */
  closure_verified: boolean;
}

/** 多表一起加锁，保证结束执行与接收结果不会分别更新出相互矛盾的状态。 */
export async function executionContext(
  client: PoolClient,
  id: string,
): Promise<ExecutionContext> {
  const result = await client.query<ExecutionContext>(
    `
    SELECT e.id,e.task_id,e.token_hash,e.lease_expires_at,e.state AS execution_state,e.action_count,e.control_mode,e.control_revision,e.control_reason,
      t.definition,t.state AS task_state,t.deadline_at,
      s.id AS session_id,s.state AS session_state,s.node_id,s.node_epoch,s.lease_id,s.fence,s.closure_verified
    FROM pr_executions e JOIN pr_tasks t ON t.id=e.task_id JOIN pr_sessions s ON s.execution_id=e.id
    WHERE e.id=$1 FOR UPDATE OF e,t,s`,
    [id],
  );
  if (!result.rows[0])
    throw new ApiError(404, 'EXECUTION_MISSING', 'Execution not found');
  return result.rows[0];
}

/** 从持久会话身份构造命令；worker 无权指定节点、租约或栅栏值。 */
export function envelope(
  context: ExecutionContext,
  command: NodeCommand['command'],
  timeoutMs: number,
  commandId: string = randomUUID(),
): NodeCommand {
  return {
    protocolVersion: '0.1',
    commandId,
    nodeId: context.node_id,
    nodeEpoch: context.node_epoch,
    sessionId: context.session_id,
    leaseId: context.lease_id,
    fence: Number(context.fence),
    timeoutMs,
    command,
  };
}

/** 所有待投递命令先持久化；事务内绝不触碰 WebSocket。 */
export async function insertCommand(
  client: PoolClient,
  executionId: string,
  command: NodeCommand,
  hash = digest(canonical(command)),
): Promise<void> {
  await client.query(
    `INSERT INTO pr_commands(id,execution_id,session_id,node_id,kind,request_hash,envelope,deadline_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+$8*interval '1 millisecond')`,
    [
      command.commandId,
      executionId,
      command.sessionId,
      command.nodeId,
      command.command.type,
      hash,
      command,
      command.timeoutMs,
    ],
  );
}

/** 控制面截止时间与传输失败的结果保留效果不确定性，不伪造浏览器已取消。 */
export function syntheticResult(
  command: NodeCommand,
  sent: boolean,
  code: string,
): CommandResult {
  const { command: _, timeoutMs: __, ...identity } = command;
  return {
    ...identity,
    type: 'command.result',
    messageId: command.commandId,
    operationStatus: code === 'DEADLINE_EXCEEDED' ? 'TIMED_OUT' : 'UNKNOWN',
    effect: sent ? 'MAY_HAVE_HAPPENED' : 'NOT_STARTED',
    error: {
      code,
      message:
        'Execution authorization ended; browser effects may require verification',
    },
  };
}

/** 标记执行停止并清理待执行命令；物理容量仍由关闭证据释放。 */
export async function stopExecution(
  client: PoolClient,
  context: ExecutionContext,
  state: 'ERROR' | 'CANCELLED' | 'TIMED_OUT' | 'COMPLETED',
  code: string,
): Promise<void> {
  if (context.execution_state === 'FINISHED') return;
  await client.query(
    `UPDATE pr_tasks SET state=$2,finished_at=clock_timestamp(),error=CASE WHEN $2='COMPLETED' THEN NULL ELSE $3::jsonb END
    WHERE id=$1 AND state IN ('QUEUED','RUNNING')`,
    [context.task_id, state, { code }],
  );
  await client.query("UPDATE pr_executions SET state='STOPPING' WHERE id=$1", [
    context.id,
  ]);
  const commands = await client.query(
    "SELECT id,envelope,first_sent_at FROM pr_commands WHERE execution_id=$1 AND result IS NULL AND kind<>'session.close' FOR UPDATE",
    [context.id],
  );
  for (const row of commands.rows) {
    await client.query('UPDATE pr_commands SET result=$2 WHERE id=$1', [
      row.id,
      syntheticResult(row.envelope, Boolean(row.first_sent_at), code),
    ]);
  }
  // 完全未尝试发送创建命令时，可以证明没有创建浏览器；传输不确定时不能走此路径。
  const launched = await client.query(
    "SELECT first_sent_at FROM pr_commands WHERE session_id=$1 AND kind='session.open'",
    [context.session_id],
  );
  if (
    context.closure_verified ||
    (context.session_state === 'OPENING' &&
      launched.rowCount &&
      !launched.rows[0].first_sent_at)
  ) {
    await releaseSession(client, context);
    return;
  }
  if (context.session_state !== 'QUARANTINED')
    await client.query("UPDATE pr_sessions SET state='CLOSING' WHERE id=$1", [
      context.session_id,
    ]);
  const closing = await client.query(
    "SELECT 1 FROM pr_commands WHERE session_id=$1 AND kind='session.close' AND result IS NULL",
    [context.session_id],
  );
  if (!closing.rowCount)
    await insertCommand(
      client,
      context.id,
      envelope(context, { type: 'session.close' }, CLOSE_TIMEOUT_MS),
    );
}

/** 只供明确的关闭确认或创建前拒绝调用；租约到期本身不构成关闭证据。 */
export async function releaseSession(
  client: PoolClient,
  context: ExecutionContext,
): Promise<void> {
  await client.query(
    "UPDATE pr_sessions SET state='CLOSED',closure_verified=true,closed_at=clock_timestamp() WHERE id=$1",
    [context.session_id],
  );
  await client.query(
    "UPDATE pr_executions SET state='FINISHED',finished_at=clock_timestamp() WHERE id=$1",
    [context.id],
  );
}
