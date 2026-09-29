import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { Database } from '../../db.js';
import { requireToken } from '../../domain.js';
import { NodeGateway } from '../nodes/gateway.js';

/** 只读画面通道不接收浏览器输入；低频状态检查独立于命令队列。 */
const FRAME_LIMIT = 2 * 1024 * 1024;
const AUTH_MS = 5000;
const CHECK_MS = 750;
/** 最近画面只作观看缓存，不登记为验收证据；限制总量及保留时间。 */
const PREVIEW_LIMIT = 16;
const PREVIEW_TTL_MS = 30 * 60 * 1000;

/** 每次读取都从数据库核实任务、租约和节点代次；不持有写入权限。 */
interface LiveGrant {
  /** 执行或流的唯一身份。 */
  id: string;
  /** 所属任务，用于检查任务终态。 */
  task_id: string;
  /** 承载此会话的节点。 */
  node_id: string;
  /** 节点代次，阻止重启前的连接重新挂载。 */
  node_epoch: string;
  /** 只允许观看的浏览器会话。 */
  session_id: string;
  /** 本次执行的租约身份。 */
  lease_id: string;
  /** 数据库返回的隔离栅栏，由节点继续校验。 */
  fence: string;
  /** 任务生命周期状态。 */
  task_state: string;
  /** 执行生命周期状态。 */
  state: string;
  /** 仅 ACTIVE 会话可以挂载画面。 */
  session_state: string;
  /** 仅 AUTO 控制权允许此只读自动观看流。 */
  control_mode: string;
  /** 控制面已提交动作数。 */
  action_count: number;
  /** 租约过期时停止继续观看。 */
  lease_expires_at: Date;
  /** 原任务截止时间，观看不会延长。 */
  deadline_at: Date;
}
/** 同一执行只建立一条节点流，多浏览器观看者共享帧并独立承受背压。 */
interface Stream {
  /** 执行或流的唯一身份。 */
  id: string;
  /** 用于合并同一执行的多个观看者。 */
  executionId: string;
  /** 最近一次从数据库核实的授权快照。 */
  grant: LiveGrant;
  /** 共享节点帧的管理员连接。 */
  viewers: Set<WebSocket>;
  /** 单条经过认证的节点画面连接。 */
  relay?: WebSocket;
  /** 定期验证租约与执行状态。 */
  timer: ReturnType<typeof setInterval>;
  /** 避免数据库检查重叠。 */
  checking: boolean;
  /** 防止重复下发挂载请求。 */
  attached: boolean;
  /** 挂载超时后释放连接以允许用户重连。 */
  attachTimer?: ReturnType<typeof setTimeout>;
}

/** 使用管理员首帧认证，只传输画面与状态，不改变 AUTO 控制权。 */
export class LiveService {
  private readonly streams = new Map<string, Stream>();
  private readonly executions = new Map<string, Stream>();
  private readonly sockets = new Set<WebSocket>();
  private readonly previews = new Map<
    string,
    {
      type: 'frame';
      data: string;
      width: number;
      height: number;
      capturedAt: number;
    }
  >();
  constructor(
    private readonly db: Database,
    private readonly gateway: NodeGateway,
    private readonly adminToken: string,
  ) {}
  /** 管理员可在任务结束或页面刷新后读取短期最后画面，过期后明确返回空值。 */
  snapshot(executionId: string) {
    const frame = this.previews.get(executionId);
    if (frame && Date.now() - frame.capturedAt > PREVIEW_TTL_MS) {
      this.previews.delete(executionId);
      return { frame: null };
    }
    return { frame: frame ?? null };
  }
  private send(socket: WebSocket, value: unknown) {
    if (
      socket.readyState === WebSocket.OPEN &&
      socket.bufferedAmount < FRAME_LIMIT
    )
      socket.send(JSON.stringify(value));
  }
  private track(socket: WebSocket) {
    this.sockets.add(socket);
    socket.on('error', () => socket.terminate());
    socket.on('close', () => this.sockets.delete(socket));
  }
  private async grant(id: string): Promise<LiveGrant | undefined> {
    return (
      await this.db.query<LiveGrant>(
        `SELECT e.id,e.task_id,e.state,e.control_mode,e.action_count,e.lease_expires_at,
      t.state AS task_state,t.deadline_at,s.id AS session_id,s.node_id,s.node_epoch,s.lease_id,s.fence,s.state AS session_state
      FROM pr_executions e JOIN pr_tasks t ON t.id=e.task_id JOIN pr_sessions s ON s.execution_id=e.id WHERE e.id=$1`,
        [id],
      )
    ).rows[0];
  }
  private end(stream: Stream, reason: string) {
    if (this.streams.get(stream.id) !== stream) return;
    this.streams.delete(stream.id);
    this.executions.delete(stream.executionId);
    clearInterval(stream.timer);
    clearTimeout(stream.attachTimer);
    stream.relay?.terminate();
    for (const socket of stream.viewers) {
      this.send(socket, { type: 'ended', reason });
      socket.close(1000);
    }
  }
  /** 首条消息携带凭据；URL、节点和帧中均不会包含管理员 token。 */
  accept(socket: WebSocket) {
    this.track(socket);
    let stream: Stream | undefined;
    let received = false;
    const timer = setTimeout(() => socket.close(4001), AUTH_MS);
    socket.on('close', () => {
      clearTimeout(timer);
      if (stream) {
        stream.viewers.delete(socket);
        if (!stream.viewers.size) this.end(stream, '观看已结束');
      }
    });
    socket.on('message', (data, binary) => {
      if (received || binary || data.toString().length > 2048) {
        socket.close(4003);
        return;
      }
      received = true;
      void (async () => {
        const message = JSON.parse(data.toString());
        if (
          message.type !== 'authenticate' ||
          typeof message.token !== 'string' ||
          typeof message.executionId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(message.executionId)
        )
          throw new Error();
        requireToken(`Bearer ${message.token}`, this.adminToken);
        const grant = await this.grant(message.executionId);
        if (!grant) throw new Error();
        if (socket.readyState !== WebSocket.OPEN) return;
        // 异步查询后再次查共享流，避免 StrictMode 或多窗口创建重复节点连接。
        stream = this.executions.get(grant.id);
        if (!stream) {
          const value: Stream = {
            id: randomUUID(),
            executionId: grant.id,
            grant,
            viewers: new Set(),
            checking: false,
            attached: false,
            timer: setInterval(() => void this.refresh(value), CHECK_MS),
          };
          stream = value;
          this.executions.set(grant.id, value);
          this.streams.set(value.id, value);
        }
        stream.viewers.add(socket);
        clearTimeout(timer);
        await this.refresh(stream);
      })().catch(() => {
        this.send(socket, {
          type: 'error',
          message: '实时画面认证失败或执行不可访问',
        });
        socket.close(4003);
      });
    });
  }
  /** 到期或人工接管立即释放节点流，不影响 Agent 的原有停止与恢复规则。 */
  private async refresh(stream: Stream) {
    if (stream.checking || !this.streams.has(stream.id)) return;
    stream.checking = true;
    try {
      const grant = await this.grant(stream.executionId);
      if (!this.streams.has(stream.id)) return;
      if (
        !grant ||
        !['QUEUED', 'RUNNING'].includes(grant.task_state) ||
        !['STARTING', 'RUNNING'].includes(grant.state) ||
        grant.deadline_at.getTime() <= Date.now() ||
        grant.lease_expires_at.getTime() <= Date.now()
      ) {
        this.end(stream, '执行已结束');
        return;
      }
      if (grant.control_mode !== 'AUTO') {
        this.end(stream, '画面已转交人工处理');
        return;
      }
      stream.grant = grant;
      for (const socket of stream.viewers)
        this.send(socket, {
          type: 'state',
          taskId: grant.task_id,
          executionState: grant.state,
          actionCount: grant.action_count,
          sessionId: grant.session_id,
        });
      if (!stream.attached && grant.session_state === 'ACTIVE') {
        stream.attached = true;
        const sent = await this.gateway.attach(grant.node_id, {
          type: 'live.attach',
          streamId: stream.id,
          sessionId: grant.session_id,
          nodeEpoch: grant.node_epoch,
          leaseId: grant.lease_id,
          fence: Number(grant.fence),
        });
        if (!sent) throw new Error();
        stream.attachTimer = setTimeout(() => {
          if (!stream.relay) this.end(stream, '节点画面连接超时，请重新连接');
        }, AUTH_MS);
      }
    } catch {
      this.end(stream, '节点画面暂时不可用，请重新连接');
    } finally {
      stream.checking = false;
    }
  }
  /** 节点凭据已在路由层认证；流身份必须同时匹配节点、代次及尚未占用的通道。 */
  relay(socket: WebSocket, nodeId: string) {
    this.track(socket);
    let stream: Stream | undefined;
    const timer = setTimeout(() => socket.close(4001), AUTH_MS);
    socket.on('close', () => {
      clearTimeout(timer);
      if (stream?.relay === socket) this.end(stream, '浏览器画面已断开');
    });
    socket.on('message', (data, binary) => {
      try {
        if (binary || data.toString().length > FRAME_LIMIT) throw new Error();
        const message = JSON.parse(data.toString());
        if (!stream) {
          const candidate = this.streams.get(message.streamId);
          if (
            message.type !== 'attach' ||
            !candidate ||
            candidate.relay ||
            candidate.grant.node_id !== nodeId ||
            candidate.grant.node_epoch !== message.nodeEpoch
          )
            throw new Error();
          stream = candidate;
          stream.relay = socket;
          clearTimeout(timer);
          clearTimeout(stream.attachTimer);
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
          throw new Error();
        const frame = {
          type: 'frame' as const,
          data: message.data,
          width: message.metadata.deviceWidth,
          height: message.metadata.deviceHeight,
          capturedAt: Date.now(),
        };
        this.previews.delete(stream.executionId);
        this.previews.set(stream.executionId, frame);
        while (this.previews.size > PREVIEW_LIMIT)
          this.previews.delete(this.previews.keys().next().value!);
        for (const viewer of stream.viewers) this.send(viewer, frame);
      } catch {
        socket.close(4003);
      }
    });
  }
  close() {
    for (const stream of this.streams.values()) this.end(stream, '服务关闭');
    for (const socket of this.sockets) socket.terminate();
  }
}
