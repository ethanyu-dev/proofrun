import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import WebSocket from 'ws';
import {
  validateNodeEvent,
  type NodeCommand,
  type NodeEvent,
} from '@proofrun/contracts';
import { ApiError, MAX_MESSAGE_BYTES, type Heartbeat } from '../../domain.js';

/** 超过三个正常心跳周期未更新的连接不参与调度。 */
const FRESH_MS = 15_000;
/** 有界消息串行处理，避免慢数据库导致网关无限积压。 */
const MAX_PENDING_FRAMES = 64;
/** 写入超时后关闭连接，后续通过持久命令恢复投递。 */
const SEND_TIMEOUT_MS = 3000;

/** 当前连接的易失状态；任务和资源所有权不能只存在于该对象中。 */
export interface Connection {
  /** 数据库注册的节点安装身份。 */
  nodeId: string;
  /** 本次连接验证过的凭据摘要，事件事务中再次核对撤销状态。 */
  credentialHash: string;
  /** 每次重新连接均改变，用于拒绝被替换连接的迟到处理。 */
  id: string;
  /** 单个节点当前的主动连接；不表示会话所有权。 */
  socket: WebSocket;
  /** 最近已持久化的心跳及其控制面接收时间。 */
  heartbeat?: Heartbeat;
  /** 控制面最近提交心跳的时间，用于剔除过期连接。 */
  lastSeen: number;
  /** 待处理帧数量及串行处理链。 */
  pending: number;
  /** 保持同一连接消息提交和 ACK 的顺序。 */
  processing: Promise<void>;
}

/** 单实例连接路由；所有入站事件交给控制面持久化后再 ACK。 */
export class NodeGateway {
  private readonly entries = new Map<string, Connection>();
  constructor(
    private readonly receive: (
      connection: Connection,
      event: NodeEvent,
    ) => Promise<void>,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** 同步装载监听器，不让异步鉴权之后的首条心跳丢失。 */
  accept(socket: WebSocket, identity: { id: string; hash: string }): void {
    const previous = this.entries.get(identity.id);
    const connection: Connection = {
      nodeId: identity.id,
      credentialHash: identity.hash,
      id: randomUUID(),
      socket,
      lastSeen: 0,
      pending: 0,
      processing: Promise.resolve(),
    };
    this.entries.set(identity.id, connection);
    previous?.socket.close(4001, 'Connection replaced');
    socket.on('error', () => socket.terminate());
    const greeting = setTimeout(() => {
      if (!connection.heartbeat) socket.terminate();
    }, FRESH_MS);
    greeting.unref();
    socket.on('close', () => {
      clearTimeout(greeting);
      if (this.current(connection)) this.entries.delete(identity.id);
    });
    socket.on('message', (data, binary) => {
      if (binary || ++connection.pending > MAX_PENDING_FRAMES) {
        socket.terminate();
        return;
      }
      connection.processing = connection.processing
        .then(async () => {
          if (!this.current(connection)) return;
          const event: unknown = JSON.parse(data.toString());
          if (!validateNodeEvent(event))
            throw new ApiError(400, 'INVALID_NODE_EVENT', 'Invalid node event');
          await this.receive(connection, event);
          if (!this.current(connection)) return;
          if (event.type === 'node.heartbeat') {
            connection.heartbeat = event;
            connection.lastSeen = Date.now();
            await this.sendValue(connection, {
              type: 'ack',
              messageId: `heartbeat:${event.leaseRequestId}`,
            });
          } else if ('messageId' in event && event.type !== 'command.pending') {
            await this.sendValue(connection, {
              type: 'ack',
              messageId: event.messageId,
            });
          }
        })
        .catch((error: unknown) => {
          this.log.warn(
            {
              nodeId: identity.id,
              error:
                error instanceof ApiError ? error.code : 'NODE_EVENT_FAILED',
            },
            '节点事件处理失败，保留未确认消息',
          );
          socket.terminate();
        })
        .finally(() => {
          connection.pending--;
        });
    });
  }

  /** 旧 socket 的关闭和延迟事件不能删除或替换新连接状态。 */
  current(connection: Connection): boolean {
    return this.entries.get(connection.nodeId) === connection;
  }
  /** 只返回近期有合法心跳的连接，用于容量与节点能力匹配。 */
  live(): Connection[] {
    return [...this.entries.values()].filter(
      (c) =>
        c.socket.readyState === WebSocket.OPEN &&
        c.heartbeat &&
        Date.now() - c.lastSeen < FRESH_MS,
    );
  }
  /** 命令必须投递到创建会话时的节点进程身份；重启后的节点不接收旧动作。 */
  async send(command: NodeCommand): Promise<boolean> {
    const connection = this.entries.get(command.nodeId);
    if (
      !connection?.heartbeat ||
      connection.heartbeat.nodeEpoch !== command.nodeEpoch ||
      Date.now() - connection.lastSeen >= FRESH_MS
    )
      return false;
    return this.sendValue(connection, command);
  }
  /** 易失画面授权不入命令账本；节点只接受绑定当前进程与租约的会话。 */
  async attach(
    nodeId: string,
    value: { nodeEpoch: string; [key: string]: unknown },
  ): Promise<boolean> {
    const connection = this.live().find(
      (c) => c.nodeId === nodeId && c.heartbeat?.nodeEpoch === value.nodeEpoch,
    );
    return connection ? this.sendValue(connection, value) : false;
  }
  /** 限制网络背压；发送成功仅表示写入传输层，不等于节点执行成功。 */
  private async sendValue(
    connection: Connection,
    value: unknown,
  ): Promise<boolean> {
    if (
      connection.socket.readyState !== WebSocket.OPEN ||
      connection.socket.bufferedAmount > MAX_MESSAGE_BYTES
    )
      return false;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        connection.socket.terminate();
        resolve(false);
      }, SEND_TIMEOUT_MS);
      connection.socket.send(JSON.stringify(value), (error) => {
        clearTimeout(timer);
        if (error) connection.socket.terminate();
        resolve(!error);
      });
    });
  }
  /** 撤销或关闭服务时终止连接；浏览器仍由租约和关闭流程约束。 */
  disconnect(nodeId: string): void {
    this.entries.get(nodeId)?.socket.terminate();
  }
  /** 先停止连接，再等待已进入数据库的事件结束，避免 ACK 先于提交。 */
  async close(): Promise<void> {
    const connections = [...this.entries.values()];
    for (const connection of connections) connection.socket.terminate();
    await Promise.all(connections.map((c) => c.processing));
    this.entries.clear();
  }
}
