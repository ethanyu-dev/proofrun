import { Database } from '../../db.js';
import { ApiError, digest } from '../../domain.js';
import { executionContext, type ExecutionContext } from './state.js';
import { randomUUID } from 'node:crypto';
import { interventionToken } from './hitl-token.js';

/** 保留近期命令即可检查介入过程；完整历史仍在数据库中。 */
const ACTIVITY_LIMIT = 100;

/** 人工控制只改变操作权，不新建会话、不续租，也不改写上层任务。 */
export class ExecutionControl {
  constructor(
    private readonly db: Database,
    private readonly secret: string,
  ) {}

  /** 请求在 worker 的安全检查点暂停；已派发命令必须先取得确定结果。 */
  async change(
    id: string,
    token: string | null,
    action: 'request' | 'acknowledge' | 'resume',
    revision: number,
    reason?: string,
    items?: string[],
  ) {
    return this.db.transaction(async (client) => {
      const context = await executionContext(client, id);
      if (token !== null && digest(token) !== context.token_hash)
        throw new ApiError(401, 'UNAUTHORIZED', 'Invalid execution credential');
      if (
        (action === 'resume' && token !== null) ||
        (action === 'acknowledge' && token === null)
      )
        throw new ApiError(
          403,
          'CONTROL_FORBIDDEN',
          'Only the worker acknowledges; only an administrator resumes',
        );
      this.active(context);
      if (!context.definition.environment.allowIntervention)
        throw new ApiError(
          409,
          'INTERVENTION_DISABLED',
          'Task does not permit human assistance',
        );
      const target =
        action === 'request'
          ? 'REQUESTED'
          : action === 'acknowledge'
            ? 'HUMAN'
            : 'AUTO';
      // 回执丢失只确认同一代次已完成的转换，不能触发下一次暂停或恢复。
      if (
        context.control_mode === target &&
        context.control_revision ===
          revision + (action === 'acknowledge' ? 0 : 1)
      )
        return this.view(context);
      if (
        revision !== context.control_revision ||
        context.control_mode !==
          (action === 'request'
            ? 'AUTO'
            : action === 'acknowledge'
              ? 'REQUESTED'
              : 'HUMAN')
      )
        throw new ApiError(
          409,
          'CONTROL_CHANGED',
          'Control state changed; refresh first',
        );
      if (
        action !== 'request' &&
        (
          await client.query(
            "SELECT 1 FROM pr_commands WHERE execution_id=$1 AND kind LIKE 'browser.%' AND result IS NULL",
            [id],
          )
        ).rowCount
      )
        throw new ApiError(
          409,
          'SESSION_BUSY',
          'Wait for the current browser command to finish',
        );
      const next = revision + (action === 'acknowledge' ? 0 : 1);
      const nextReason =
        action === 'request' ? reason! : context.control_reason;
      await client.query(
        'UPDATE pr_executions SET control_mode=$2,control_revision=$3,control_reason=$4 WHERE id=$1',
        [id, target, next, nextReason],
      );
      await client.query(
        'INSERT INTO pr_control_events(execution_id,mode,revision,reason) VALUES($1,$2,$3,$4)',
        [id, target, next, nextReason],
      );
      if (action === 'request') {
        const interventionId = randomUUID();
        await client.query(
          'INSERT INTO pr_interventions(id,execution_id,revision,token_hash,items,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
          [
            interventionId,
            id,
            next,
            digest(interventionToken(this.secret, interventionId)),
            JSON.stringify(items ?? [reason!]),
            new Date(
              Math.min(context.deadline_at.getTime(), Date.now() + 30 * 60_000),
            ),
          ],
        );
      } else if (action === 'resume') {
        await client.query(
          'UPDATE pr_interventions SET completed_at=clock_timestamp() WHERE execution_id=$1 AND revision=$2',
          [id, revision],
        );
      }
      return {
        controlMode: target,
        controlRevision: next,
        controlReason: nextReason,
      };
    });
  }

  private active(context: ExecutionContext) {
    if (
      context.task_state !== 'RUNNING' ||
      context.execution_state !== 'RUNNING' ||
      context.session_state !== 'ACTIVE' ||
      context.lease_expires_at.getTime() <= Date.now() ||
      context.deadline_at.getTime() <= Date.now()
    )
      throw new ApiError(
        409,
        'EXECUTION_EXPIRED',
        'Active browser and worker lease required',
      );
  }

  private view(context: ExecutionContext) {
    return {
      controlMode: context.control_mode,
      controlRevision: context.control_revision,
      controlReason: context.control_reason,
    };
  }

  /** 管理页面只读操作摘要，不返回命令输入值、机器凭据或执行令牌。 */
  async activity(id: string) {
    const result = await this.db.query(
      'SELECT id FROM pr_executions WHERE id=$1',
      [id],
    );
    if (!result.rowCount)
      throw new ApiError(404, 'EXECUTION_MISSING', 'Execution not found');
    const [commands, events, observation, artifacts] = await Promise.all([
      this.db.query(
        `SELECT id,kind,actor,envelope#>>'{command,action}' AS action,result->>'operationStatus' AS status,result->>'effect' AS effect,result#>>'{error,code}' AS error,created_at FROM pr_commands WHERE execution_id=$1 AND kind<>'session.renew' ORDER BY created_at DESC,id DESC LIMIT $2`,
        [id, ACTIVITY_LIMIT],
      ),
      this.db.query(
        'SELECT mode,revision,reason,created_at FROM pr_control_events WHERE execution_id=$1 ORDER BY id DESC LIMIT $2',
        [id, ACTIVITY_LIMIT],
      ),
      this.db.query(
        "SELECT result->'data' AS data FROM pr_commands WHERE execution_id=$1 AND kind='browser.observe' AND result->>'operationStatus'='SUCCEEDED' ORDER BY created_at DESC,id DESC LIMIT 1",
        [id],
      ),
      this.db.query(
        "SELECT id,kind,hash AS sha256 FROM pr_artifacts WHERE execution_id=$1 AND state='AVAILABLE' ORDER BY created_at DESC LIMIT $2",
        [id, ACTIVITY_LIMIT],
      ),
    ]);
    return {
      commands: commands.rows,
      events: events.rows,
      observation: observation.rows[0]?.data ?? null,
      artifacts: artifacts.rows,
      limit: ACTIVITY_LIMIT,
    };
  }
}
