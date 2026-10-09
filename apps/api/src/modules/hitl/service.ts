import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  validateHitlClient,
  type NodeCommand,
  type HitlServer,
} from '@proofrun/contracts';
import { Database } from '../../db.js';
import { ApiError, digest } from '../../domain.js';
import type { ApiConfig } from '../../config.js';
import { ExecutionControl } from '../scheduling/control.js';
import { interventionToken } from '../scheduling/hitl-token.js';
import { Coordinator } from '../scheduling/coordinator.js';
import { NodeGateway } from '../nodes/gateway.js';
import { sendHitlMessage } from './transport.js';

/** 画面独立于持久命令，丢弃慢客户端旧帧；输入严格串行且不自动重试。 */
const FRAME_LIMIT = 2 * 1024 * 1024;
const AUTH_MS = 5000;
const CHECK_MS = 500;
const COMMAND_MS = 15000;
const INPUT_LIMIT = 8;
/** 允许 4096 字符的 JSON 转义文本；画面仍使用独立的单帧上限。 */
const INPUT_MESSAGE_BYTES = 32 * 1024;

/** 仅包含本次介入的权限和待办，不返回任务定义、历史报告或任何平台凭据。 */
interface Grant {
  id: string;
  execution_id: string;
  revision: number;
  token_hash: string;
  items: string[];
  expires_at: Date;
  completed_at: Date | null;
  control_mode: string;
  control_revision: number;
  control_reason: string;
  task_state: string;
  execution_state: string;
  session_state: string;
  deadline_at: Date;
  lease_expires_at: Date;
  task_id: string;
  node_id: string;
  node_epoch: string;
  session_id: string;
  lease_id: string;
  fence: string;
  /** 会话实际使用的登录槽位，包含自动分配槽位。 */
  auth: unknown;
  /** 仅用于人工确认 Cookie 所属站点。 */
  target_url: string;
}
interface Viewer {
  socket: WebSocket;
  grant: Grant;
  streamId?: string;
  relay?: WebSocket;
  pending: number;
  checking: boolean;
  timer: ReturnType<typeof setInterval>;
}

/** 任务专属入口；所有修改仍交给原调度器和控制权事务。 */
export class HitlService {
  private readonly viewers = new Map<string, Viewer>();
  private readonly streams = new Map<string, Viewer>();
  private readonly sockets = new Set<WebSocket>();
  constructor(
    private readonly db: Database,
    private readonly config: ApiConfig,
    private readonly control: ExecutionControl,
    private readonly coordinator: Coordinator,
    private readonly gateway: NodeGateway,
  ) {}

  private async grant(id: string): Promise<Grant> {
    const row = (
      await this.db.query<Grant>(
        `SELECT h.*,e.control_mode,e.control_revision,e.control_reason,
      t.definition->'target'->>'url' AS target_url,e.state AS execution_state,e.lease_expires_at,t.id AS task_id,t.state AS task_state,t.deadline_at,
      s.auth_state AS auth,s.id AS session_id,s.node_id,s.node_epoch,s.lease_id,s.fence,s.state AS session_state
      FROM pr_interventions h JOIN pr_executions e ON e.id=h.execution_id JOIN pr_tasks t ON t.id=e.task_id
      JOIN pr_sessions s ON s.execution_id=e.id WHERE h.id=$1`,
        [id],
      )
    ).rows[0];
    if (!row) throw new ApiError(401, 'HITL_INVALID', '处理链接无效');
    return row;
  }
  private active(grant: Grant): void {
    if (
      grant.completed_at ||
      grant.expires_at.getTime() <= Date.now() ||
      grant.deadline_at.getTime() <= Date.now() ||
      grant.lease_expires_at.getTime() <= Date.now() ||
      grant.task_state !== 'RUNNING' ||
      grant.execution_state !== 'RUNNING' ||
      grant.session_state !== 'ACTIVE' ||
      grant.revision !== grant.control_revision ||
      !['REQUESTED', 'HUMAN'].includes(grant.control_mode)
    )
      throw new ApiError(410, 'HITL_ENDED', '处理已结束或链接已失效');
  }
  /** 只供已经验证过执行者或管理员身份的 HTTP 路由读取链接。 */
  async current(executionId: string) {
    const row = (
      await this.db.query(
        'SELECT id FROM pr_interventions WHERE execution_id=$1 ORDER BY revision DESC LIMIT 1',
        [executionId],
      )
    ).rows[0];
    if (!row) return { intervention: null };
    const grant = await this.grant(row.id);
    try {
      this.active(grant);
    } catch {
      return { intervention: null };
    }
    const token = interventionToken(this.config.adminToken, grant.id);
    const path = `/#/hitl/${grant.id}/${token}`;
    return {
      intervention: {
        id: grant.id,
        items: grant.items,
        expiresAt: grant.expires_at.toISOString(),
        path,
        url: `${this.config.consoleUrl ?? this.config.publicUrl}${path}`,
      },
    };
  }
  private send(socket: WebSocket, value: HitlServer): void {
    sendHitlMessage(socket, value);
  }
  private end(viewer: Viewer): void {
    clearInterval(viewer.timer);
    if (this.viewers.get(viewer.grant.id) === viewer)
      this.viewers.delete(viewer.grant.id);
    if (viewer.streamId) this.streams.delete(viewer.streamId);
    viewer.relay?.terminate();
    viewer.socket.close(1000);
  }
  private tracked(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.on('error', () => socket.terminate());
    socket.on('close', () => this.sockets.delete(socket));
  }
  private error(socket: WebSocket, error: unknown) {
    this.send(socket, {
      type: 'error',
      code: error instanceof ApiError ? error.code : 'HITL_UNAVAILABLE',
      message:
        error instanceof ApiError
          ? error.message
          : '处理连接暂不可用，请重新连接；未确认的操作不会自动重试',
    });
  }
  /** 首条消息认证，凭据不进入 URL、代理日志或节点；单一处理者占有当前连接。 */
  accept(socket: WebSocket): void {
    this.tracked(socket);
    let viewer: Viewer | undefined;
    let queued = 0;
    let chain = Promise.resolve();
    const authTimer = setTimeout(() => socket.close(4001), AUTH_MS);
    socket.on('close', () => {
      clearTimeout(authTimer);
      if (viewer) this.end(viewer);
    });
    socket.on('message', (data, binary) => {
      if (
        binary ||
        Buffer.byteLength(data.toString()) > INPUT_MESSAGE_BYTES ||
        ++queued > INPUT_LIMIT
      ) {
        socket.close(4008);
        return;
      }
      chain = chain
        .then(async () => {
          if (socket.readyState !== WebSocket.OPEN) return;
          const message: unknown = JSON.parse(data.toString());
          if (!validateHitlClient(message))
            throw new ApiError(400, 'HITL_MESSAGE', '无效的处理消息');
          if (!viewer) {
            if (message.type !== 'authenticate')
              throw new ApiError(401, 'HITL_INVALID', '请使用完整处理链接');
            const grant = await this.grant(message.id);
            if (digest(message.token) !== grant.token_hash)
              throw new ApiError(401, 'HITL_INVALID', '处理链接无效');
            if (grant.completed_at) {
              this.send(socket, { type: 'completed' });
              socket.close();
              return;
            }
            this.active(grant);
            if (socket.readyState !== WebSocket.OPEN) return;
            if (this.viewers.has(grant.id))
              throw new ApiError(
                409,
                'HITL_OCCUPIED',
                '此任务已在另一个处理页打开',
              );
            viewer = {
              socket,
              grant,
              pending: 0,
              checking: false,
              timer: setInterval(() => {
                if (viewer) void this.refresh(viewer);
              }, CHECK_MS),
            };
            this.viewers.set(grant.id, viewer);
            clearTimeout(authTimer);
            await this.refresh(viewer);
            return;
          }
          const grant = await this.grant(viewer.grant.id);
          this.active(grant);
          if (grant.control_mode !== 'HUMAN')
            throw new ApiError(409, 'HITL_WAIT', '正在等待 Agent 完成交接');
          if (message.type === 'complete') {
            const authStatus = grant.auth
              ? await this.saveAuth(grant, socket)
              : 'disabled';
            // 保存有确定回执后才恢复；失败或断线保留人工控制权。
            if (socket.readyState !== WebSocket.OPEN) return;
            await this.control.change(
              grant.execution_id,
              null,
              'resume',
              grant.revision,
            );
            this.send(socket, { type: 'completed', authStatus });
            this.end(viewer);
          } else if (message.type === 'command') {
            const operation = message.command;
            if (
              ![
                'browser.input',
                'browser.auth.save',
                'browser.cookies.set',
              ].includes(operation.type) ||
              (operation.type === 'browser.auth.save' && !grant.auth)
            )
              throw new ApiError(403, 'HITL_COMMAND', '此处理页不允许该操作');
            if (operation.type === 'browser.input')
              this.validateInput(operation);
            viewer.pending++;
            try {
              const receipt = await this.coordinator.command(
                grant.execution_id,
                null,
                message.commandId,
                COMMAND_MS,
                operation,
                grant.revision,
              );
              let result = receipt.result;
              const until = Date.now() + COMMAND_MS + 5000;
              while (
                !result &&
                Date.now() < until &&
                socket.readyState === WebSocket.OPEN
              ) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                result = (
                  await this.db.query(
                    'SELECT result FROM pr_commands WHERE id=$1 AND execution_id=$2',
                    [message.commandId, grant.execution_id],
                  )
                ).rows[0]?.result;
              }
              this.send(socket, {
                type: 'result',
                commandId: message.commandId,
                status: result?.operationStatus ?? 'UNKNOWN',
                effect: result?.effect ?? 'MAY_HAVE_HAPPENED',
              });
              if (!result || result.operationStatus !== 'SUCCEEDED') {
                // 未知输入不能自动重放，也不能接着派发本地队列中的下一次操作。
                this.end(viewer);
              }
            } finally {
              viewer.pending--;
            }
          } else throw new ApiError(400, 'HITL_MESSAGE', '连接已经认证');
        })
        .catch((error) => {
          this.error(socket, error);
          if (
            !viewer ||
            !(error instanceof ApiError) ||
            ![
              'SESSION_BUSY',
              'ACTION_BUDGET_EXCEEDED',
              'HITL_WAIT',
              'INVALID_INPUT',
            ].includes(error.code)
          )
            socket.close(4003);
        })
        .finally(() => {
          queued--;
        });
    });
  }
  /** 完成操作使用稳定命令身份；断线重连只查询原回执，不重复导出或覆盖登录。 */
  private async saveAuth(
    grant: Grant,
    socket: WebSocket,
  ): Promise<'saved' | 'newer'> {
    const prefix = `auth-complete-${grant.id}-`;
    const previous = (
      await this.db.query(
        'SELECT id,result FROM pr_commands WHERE execution_id=$1 AND id LIKE $2 ORDER BY created_at DESC LIMIT 1',
        [grant.execution_id, `${prefix}%`],
      )
    ).rows[0];
    // 确定未保存的失败允许人工再次尝试；回执未知时只能追踪原命令。
    const retryable =
      previous?.result?.operationStatus === 'FAILED' &&
      previous.result.effect === 'NOT_STARTED';
    const commandId =
      previous && !retryable ? previous.id : `${prefix}${randomUUID()}`;
    const receipt = await this.coordinator.command(
      grant.execution_id,
      null,
      commandId,
      COMMAND_MS,
      { type: 'browser.auth.save' },
      grant.revision,
    );
    let result = receipt.result;
    const deadline = Date.now() + COMMAND_MS + 5000;
    while (
      !result &&
      Date.now() < deadline &&
      socket.readyState === WebSocket.OPEN
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      result = (
        await this.db.query(
          'SELECT result FROM pr_commands WHERE id=$1 AND execution_id=$2',
          [commandId, grant.execution_id],
        )
      ).rows[0]?.result;
    }
    if (
      result?.operationStatus !== 'SUCCEEDED' ||
      (result.data?.saved !== true &&
        result.data?.reason !== 'NEWER_STATE_PRESERVED')
    )
      throw new ApiError(
        409,
        'AUTH_SAVE_FAILED',
        '登录状态未确认保存，任务仍等待人工处理；请检查节点后重新连接。',
      );
    return result.data.saved === true ? 'saved' : 'newer';
  }

  private validateInput(
    operation: Extract<NodeCommand['command'], { type: 'browser.input' }>,
  ): void {
    const positioned =
      Number.isFinite(operation.x) && Number.isFinite(operation.y);
    const keys = [
      'Enter',
      'Tab',
      'Shift+Tab',
      'Backspace',
      'Delete',
      'Escape',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'Control+a',
      'Meta+a',
      'Space',
      'Minus',
    ];
    const valid =
      operation.action === 'click'
        ? positioned
        : operation.action === 'scroll'
          ? positioned &&
            Number.isInteger(operation.deltaX) &&
            Number.isInteger(operation.deltaY)
          : operation.action === 'press'
            ? keys.includes(operation.value ?? '')
            : !!operation.value && !operation.value.includes('\0');
    if (!valid)
      throw new ApiError(400, 'INVALID_INPUT', '输入不完整或不支持该按键');
  }
  /** 持续核对原任务权限；取消、过期、管理员恢复后立即关闭处理连接。 */
  private async refresh(viewer: Viewer): Promise<void> {
    if (viewer.checking || viewer.socket.readyState !== WebSocket.OPEN) return;
    viewer.checking = true;
    try {
      const grant = await this.grant(viewer.grant.id);
      if (viewer.socket.readyState !== WebSocket.OPEN) return;
      if (grant.completed_at) {
        this.send(viewer.socket, { type: 'completed' });
        this.end(viewer);
        return;
      }
      this.active(grant);
      viewer.grant = grant;
      this.send(viewer.socket, {
        type: 'state',
        taskId: grant.task_id,
        reason: grant.control_reason,
        items: grant.items,
        mode: grant.control_mode as 'REQUESTED' | 'HUMAN',
        expiresAt: grant.expires_at.toISOString(),
        canSaveAuth: !!grant.auth,
        targetUrl: grant.target_url,
      });
      if (grant.control_mode === 'HUMAN' && !viewer.streamId) {
        const streamId = randomUUID();
        viewer.streamId = streamId;
        this.streams.set(streamId, viewer);
        const sent = await this.gateway.attach(grant.node_id, {
          type: 'hitl.attach',
          streamId,
          sessionId: grant.session_id,
          nodeEpoch: grant.node_epoch,
          leaseId: grant.lease_id,
          fence: Number(grant.fence),
        });
        if (!sent)
          throw new ApiError(503, 'HITL_NODE_OFFLINE', '浏览器节点暂时离线');
        // 未收到节点通道时关闭连接，重连会创建新授权，不复用迟到通道。
        const timer = setTimeout(() => {
          if (this.streams.get(streamId) === viewer && !viewer.relay) {
            this.error(
              viewer.socket,
              new ApiError(
                503,
                'HITL_STREAM',
                '浏览器画面连接失败，请重新连接',
              ),
            );
            this.end(viewer);
          }
        }, AUTH_MS);
        timer.unref();
      }
    } catch (error) {
      this.error(viewer.socket, error);
      this.end(viewer);
    } finally {
      viewer.checking = false;
    }
  }
  /** 节点身份由网关路由先认证；仅中转当前授权的 JPEG 画面，绝不暴露原生调试接口。 */
  relay(socket: WebSocket, nodeId: string): void {
    this.tracked(socket);
    let viewer: Viewer | undefined;
    const timer = setTimeout(() => socket.close(4001), AUTH_MS);
    socket.on('close', () => {
      clearTimeout(timer);
      if (viewer && viewer.relay === socket) {
        this.error(
          viewer.socket,
          new ApiError(503, 'HITL_STREAM', '浏览器画面已断开，请重新连接'),
        );
        this.end(viewer);
      }
    });
    socket.on('message', (data, binary) => {
      try {
        if (binary || data.toString().length > FRAME_LIMIT)
          throw new Error('frame limit');
        const message = JSON.parse(data.toString());
        if (!viewer) {
          const candidate = this.streams.get(message.streamId);
          if (
            message.type !== 'attach' ||
            !candidate ||
            candidate.relay ||
            candidate.grant.node_id !== nodeId ||
            candidate.grant.node_epoch !== message.nodeEpoch
          )
            throw new Error('invalid relay');
          viewer = candidate;
          viewer.relay = socket;
          clearTimeout(timer);
          return;
        }
        if (
          message.type !== 'frame' ||
          typeof message.data !== 'string' ||
          !/^[A-Za-z0-9+/=]+$/.test(message.data) ||
          !Number.isFinite(message.metadata?.deviceWidth) ||
          !Number.isFinite(message.metadata?.deviceHeight) ||
          message.metadata.deviceWidth <= 0 ||
          message.metadata.deviceWidth > 16384 ||
          message.metadata.deviceHeight <= 0 ||
          message.metadata.deviceHeight > 16384
        )
          throw new Error('invalid frame');
        this.send(viewer.socket, {
          type: 'frame',
          data: message.data,
          width: message.metadata.deviceWidth,
          height: message.metadata.deviceHeight,
        });
      } catch {
        socket.close(4003);
      }
    });
  }
  close(): void {
    for (const viewer of this.viewers.values()) this.end(viewer);
    for (const socket of this.sockets) socket.terminate();
  }
}
