import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { HitlServer, NodeEvent } from '@proofrun/contracts';
import { Database } from '../../db.js';
import { ApiError, digest, newToken } from '../../domain.js';
import type { ApiConfig } from '../../config.js';
import { ExecutionControl } from '../scheduling/control.js';
import { interventionToken } from '../scheduling/hitl-token.js';
import {
  executionContext,
  envelope,
  insertCommand,
  stopExecution,
} from '../scheduling/state.js';

/** 连接凭证仅用于一次连接；实际连接仍服从人工期限、控制代次和节点短租约。 */
const CONNECT_MS = 60_000;
const INSTALL_MS = 10_000;
type HumanEvent = Extract<NodeEvent, { type: 'hitl.result' | 'hitl.finished' }>;

/** API 只签发节点能力和处理持久交接事件，画面及输入不再经过 API。 */
export class HitlService {
  constructor(
    private readonly db: Database,
    private readonly config: ApiConfig,
    private readonly control: ExecutionControl,
  ) {}

  /** 返回的处理链接是 API 入口凭证，不能直接作为节点凭证使用。 */
  async current(executionId: string) {
    const id = await this.control.currentInterventionId(executionId);
    if (!id) return { intervention: null };
    const row = (
      await this.db.query('SELECT * FROM pr_interventions WHERE id=$1', [id])
    ).rows[0];
    if (!row) return { intervention: null };
    const path = `/#/hitl/${id}/${interventionToken(this.config.adminToken, id)}`;
    return {
      intervention: {
        id,
        items: row.items,
        ...(row.condition_keys ? { conditionKeys: row.condition_keys } : {}),
        expiresAt: row.expires_at.toISOString(),
        path,
        url: `${this.config.consoleUrl ?? this.config.publicUrl}${path}`,
      },
    };
  }

  /** 在短事务内核实原链接并安装摘要，网络等待在提交后进行。 */
  async bootstrap(input: unknown): Promise<{
    state: HitlServer;
    direct?: {
      controlUrl: string;
      frameUrl: string;
      id: string;
      token: string;
    };
  }> {
    const { id, token } = (input ?? {}) as { id?: string; token?: string };
    if (
      typeof id !== 'string' ||
      id.length > 128 ||
      typeof token !== 'string' ||
      token.length > 512
    )
      throw new ApiError(401, 'HITL_INVALID', '处理链接无效');
    const result = await this.db.transaction(async (client) => {
      const link = (
        await client.query('SELECT * FROM pr_interventions WHERE id=$1', [id])
      ).rows[0];
      if (!link || digest(token) !== link.token_hash)
        throw new ApiError(401, 'HITL_INVALID', '处理链接无效');
      if (link.completed_at) {
        if (!link.unable_reason) {
          const transition = (
            await client.query(
              "SELECT result FROM pr_commands WHERE execution_id=$1 AND kind='session.control' AND envelope#>>'{command,revision}'=$2 AND envelope#>>'{command,mode}'='AUTO' ORDER BY created_at DESC LIMIT 1",
              [link.execution_id, String(link.revision + 1)],
            )
          ).rows[0];
          if (transition && !transition.result) {
            const pending = await executionContext(client, link.execution_id);
            return {
              state: {
                type: 'state',
                taskId: pending.task_id,
                reason: pending.control_reason ?? '',
                items: link.items,
                mode: 'REQUESTED',
                expiresAt: link.expires_at.toISOString(),
                canSaveAuth: false,
                finalizing: true,
              } as HitlServer,
            };
          }
          if (
            transition?.result?.operationStatus &&
            transition.result.operationStatus !== 'SUCCEEDED'
          )
            throw new ApiError(
              410,
              'HITL_ENDED',
              '节点未完成控制权交接，请从任务页检查执行结果',
            );
        }
        return {
          state: (link.unable_reason
            ? { type: 'unable', reason: link.unable_reason }
            : { type: 'completed' }) as HitlServer,
        };
      }
      const context = await executionContext(client, link.execution_id);
      if (
        link.expires_at <= new Date() ||
        link.revision !== context.control_revision ||
        !['REQUESTED', 'HUMAN'].includes(context.control_mode) ||
        context.execution_state !== 'RUNNING' ||
        context.task_state !== 'RUNNING' ||
        context.session_state !== 'ACTIVE' ||
        context.lease_expires_at <= new Date() ||
        (context.human_deadline_at &&
          context.human_deadline_at <= new Date()) ||
        (context.external_expires_at &&
          context.external_expires_at <= new Date())
      )
        throw new ApiError(410, 'HITL_ENDED', '处理已结束或链接已失效');
      const state: HitlServer = {
        type: 'state',
        taskId: context.task_id,
        reason: context.control_reason ?? '',
        items: link.items,
        mode: context.control_mode as 'REQUESTED' | 'HUMAN',
        expiresAt: link.expires_at.toISOString(),
        canSaveAuth: false,
        targetUrl: context.definition.target.url,
        ...(link.condition_keys ? { conditionKeys: link.condition_keys } : {}),
      };
      if (context.control_mode === 'REQUESTED') return { state };
      // 交接命令得到节点确认之前只显示等待，避免签发凭证时越过旧自动动作。
      const transition = await client.query(
        "SELECT result FROM pr_commands WHERE execution_id=$1 AND kind='session.control' AND envelope#>>'{command,revision}'=$2 AND envelope#>>'{command,mode}'='HUMAN' AND NOT (envelope->'command' ? 'grant') ORDER BY created_at DESC LIMIT 1",
        [context.id, String(context.control_revision)],
      );
      if (!transition.rows[0]?.result)
        return { state: { ...state, mode: 'REQUESTED' } as HitlServer };
      if (transition.rows[0].result.operationStatus !== 'SUCCEEDED')
        throw new ApiError(409, 'HITL_CONTROL', '节点尚未确认人工控制权');
      const node = (
        await client.query(
          'SELECT public_url,capabilities,node_epoch FROM pr_nodes WHERE id=$1',
          [context.node_id],
        )
      ).rows[0];
      if (
        !node?.public_url ||
        !node.capabilities.directHitl ||
        node.node_epoch !== context.node_epoch
      )
        throw new ApiError(
          409,
          'HITL_DIRECT_UNAVAILABLE',
          '节点未配置客户端直连域名',
        );
      const credential = newToken();
      const commandId = randomUUID();
      await insertCommand(
        client,
        context.id,
        envelope(
          context,
          {
            type: 'session.control',
            mode: 'HUMAN',
            revision: context.control_revision,
            grant: {
              id,
              tokenHash: digest(credential),
              connectExpiresAt: Date.now() + CONNECT_MS,
              expiresAt: Math.min(
                link.expires_at.getTime(),
                context.human_deadline_at?.getTime() ?? Infinity,
                context.external_expires_at?.getTime() ?? Infinity,
              ),
              origin: new URL(this.config.consoleUrl ?? this.config.publicUrl)
                .origin,
              authRevision: context.auth_revision,
              state,
            },
          },
          INSTALL_MS,
          commandId,
        ),
      );
      const url = new URL('/hitl/control', node.public_url);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const frames = new URL(url);
      frames.pathname = '/hitl/frames';
      return {
        state,
        commandId,
        direct: {
          nodeId: context.node_id,
          controlUrl: url.toString(),
          frameUrl: frames.toString(),
          id,
          token: credential,
        },
      };
    });
    if ('commandId' in result) {
      const until = Date.now() + INSTALL_MS;
      while (Date.now() < until) {
        const row = (
          await this.db.query('SELECT result FROM pr_commands WHERE id=$1', [
            result.commandId,
          ])
        ).rows[0];
        if (row?.result) {
          if (row.result.operationStatus !== 'SUCCEEDED')
            throw new ApiError(
              409,
              row.result.error?.code ?? 'HITL_DIRECT_UNAVAILABLE',
              '节点未接受连接授权，请稍后重连',
            );
          return { state: result.state, direct: result.direct! };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new ApiError(
        503,
        'HITL_NODE_OFFLINE',
        '等待节点连接授权超时，请重连',
      );
    }
    return result;
  }

  /** 已认证节点事件与 inbox 去重同事务提交；完成事件携带完整认证版本，不依赖消息到达顺序。 */
  async receive(
    client: PoolClient,
    nodeId: string,
    event: HumanEvent,
  ): Promise<void> {
    const row = (
      await client.query(
        'SELECT execution_id FROM pr_sessions WHERE id=$1 AND node_id=$2 AND node_epoch=$3 AND lease_id=$4 AND fence=$5',
        [event.sessionId, nodeId, event.nodeEpoch, event.leaseId, event.fence],
      )
    ).rows[0];
    if (!row || event.nodeId !== nodeId)
      throw new ApiError(409, 'HITL_IDENTITY', '人工事件身份不匹配');
    const context = await executionContext(client, row.execution_id);
    const link = (
      await client.query(
        'SELECT * FROM pr_interventions WHERE id=$1 AND execution_id=$2 AND revision=$3',
        [event.interventionId, context.id, event.controlRevision],
      )
    ).rows[0];
    // 操作摘要允许晚于完成事件抵达；旧结果不能改变新的执行权。
    if (link && event.type === 'hitl.result')
      await client.query(
        'INSERT INTO pr_human_commands(id,execution_id,result) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [event.commandId, context.id, event],
      );
    // 过期/已取消事件仍由 inbox 留档，但不能改变新的控制代次。
    if (
      !link ||
      context.control_revision !== event.controlRevision ||
      context.control_mode !== 'HUMAN' ||
      context.task_state !== 'RUNNING' ||
      context.execution_state !== 'RUNNING' ||
      context.session_state !== 'ACTIVE'
    )
      return;
    await client.query(
      'UPDATE pr_executions SET auth_revision=GREATEST(auth_revision,$2) WHERE id=$1',
      [context.id, event.authRevision],
    );
    if (event.type === 'hitl.result') {
      if (event.effect === 'MAY_HAVE_HAPPENED')
        await stopExecution(client, context, 'ERROR', 'HITL_OPERATION_UNKNOWN');
      return;
    }
    // 到期交接不恢复自动任务；仍确认事件，避免已结束事件阻塞节点可靠队列。
    if (
      context.lease_expires_at <= new Date() ||
      (context.human_deadline_at && context.human_deadline_at <= new Date()) ||
      (context.external_expires_at && context.external_expires_at <= new Date())
    )
      return;
    const completion = event.completion;
    if (completion.type === 'unable') {
      await this.control.unable(
        context.id,
        event.controlRevision,
        completion.reason ?? '',
        this.config.publicUrl,
        client,
      );
      return;
    }
    const checked = completion.confirmedItems as number[] | undefined;
    const keys = completion.confirmedConditionKeys as string[] | undefined;
    if (
      !checked ||
      checked.length !== link.items.length ||
      !link.items.every((_: string, i: number) => checked.includes(i)) ||
      (link.condition_keys &&
        (!completion.confirmedConditionKeys ||
          completion.confirmedConditionKeys.length !==
            link.condition_keys.length ||
          !link.condition_keys.every((k: string) => keys!.includes(k))))
    )
      throw new ApiError(422, 'HITL_CONFIRMATION_REQUIRED', '待办确认不完整');
    await this.control.change(
      context.id,
      null,
      'resume',
      event.controlRevision,
      undefined,
      undefined,
      undefined,
      checked.map((i) => link.items[i]),
      undefined,
      completion.confirmedConditionKeys,
      client,
    );
  }
}
