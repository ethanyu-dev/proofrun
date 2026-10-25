import { randomUUID } from 'node:crypto';
import { Database } from '../../db.js';
import { ApiError, digest, newToken } from '../../domain.js';
import {
  executionContext,
  envelope,
  insertCommand,
} from '../scheduling/state.js';

/** 只读凭证有界且只能消费一次；媒体字节直接从节点流向客户端。 */
const VIEW_MS = 5 * 60_000;
const INSTALL_MS = 10_000;
export class LiveService {
  constructor(
    private readonly db: Database,
    private readonly consoleOrigin: string,
  ) {}
  /** 管理员身份已由路由验证，节点永远收不到管理员密钥。 */
  async bootstrap(executionId: string) {
    const ticket = await this.db.transaction(async (client) => {
      const context = await executionContext(client, executionId);
      if (
        context.task_state !== 'RUNNING' ||
        !['STARTING', 'RUNNING'].includes(context.execution_state) ||
        context.lease_expires_at <= new Date()
      )
        throw new ApiError(410, 'LIVE_ENDED', '执行已结束');
      if (context.control_mode !== 'AUTO')
        throw new ApiError(409, 'LIVE_HUMAN', '画面已交给人工处理');
      if (context.session_state !== 'ACTIVE') return { waiting: true as const };
      const node = (
        await client.query(
          'SELECT public_url,capabilities FROM pr_nodes WHERE id=$1',
          [context.node_id],
        )
      ).rows[0];
      if (!node?.public_url || !node.capabilities.directHitl)
        throw new ApiError(
          409,
          'LIVE_DIRECT_UNAVAILABLE',
          '节点未配置客户端直连域名',
        );
      const id = randomUUID(),
        token = newToken(),
        commandId = randomUUID();
      await insertCommand(
        client,
        context.id,
        envelope(
          context,
          {
            type: 'session.watch',
            revision: context.control_revision,
            grant: {
              id,
              tokenHash: digest(token),
              connectExpiresAt: Date.now() + 60_000,
              expiresAt: Math.min(
                Date.now() + VIEW_MS,
                context.deadline_at.getTime(),
              ),
              origin: this.consoleOrigin,
              authRevision: context.auth_revision,
              state: {},
            },
          },
          INSTALL_MS,
          commandId,
        ),
      );
      const url = new URL('/live/frames', node.public_url);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return {
        waiting: false as const,
        nodeId: context.node_id,
        id,
        token,
        url: url.toString(),
        commandId,
      };
    });
    if (ticket.waiting) return ticket;
    const until = Date.now() + INSTALL_MS;
    while (Date.now() < until) {
      const row = (
        await this.db.query('SELECT result FROM pr_commands WHERE id=$1', [
          ticket.commandId,
        ])
      ).rows[0];
      if (row?.result) {
        if (row.result.operationStatus !== 'SUCCEEDED')
          throw new ApiError(
            409,
            'LIVE_DIRECT_UNAVAILABLE',
            '节点未接受观看授权',
          );
        return {
          waiting: false as const,
          nodeId: ticket.nodeId,
          id: ticket.id,
          token: ticket.token,
          url: ticket.url,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new ApiError(503, 'LIVE_NODE_OFFLINE', '等待节点授权超时');
  }
}
