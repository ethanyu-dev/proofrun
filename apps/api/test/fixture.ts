import { randomUUID, createHash } from 'node:crypto';
import WebSocket from 'ws';
import type { NodeCommand } from '@proofrun/contracts';

/** 故障测试的轮询间隔；不代表生产调度周期。 */
const POLL_MS = 25;
/** 有效的最小 PNG；只验证存储链路，不用于证明真实截图内容。 */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=',
  'base64',
);
export const PNG_HASH = createHash('sha256').update(PNG).digest('hex');
/** 只验证 TRACE 文件交付协议，事件由夹具生成，不代表真实 Chrome 采集。 */
export const TRACE = Buffer.from(
  JSON.stringify({
    traceEvents: [{ name: 'fixture', ph: 'i', ts: 1, pid: 1, tid: 1 }],
  }),
);
export const TRACE_HASH = createHash('sha256').update(TRACE).digest('hex');

/** 等待真实 HTTP/数据库状态变化，超过期限明确失败。 */
export async function until<T>(
  read: () => Promise<T> | T,
  accept: (value: T) => boolean,
  timeout = 6000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (accept(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error('等待控制面状态超时');
}

/** 最小任务夹具，标准由调用方提交，测试不会生成或修改标准。 */
export function task(pool: string, screenshot = false) {
  return {
    protocolVersion: '0.1',
    taskId: randomUUID() as string,
    objective: '验证测试页面',
    environment: { id: 'fixture', nodePool: pool },
    target: { url: 'http://127.0.0.1/fixture' },
    acceptanceCriteria: [
      {
        id: 'visible',
        description: '页面可观察',
        expectedResult: '取得页面事实',
        evidenceKinds: screenshot ? ['DOM', 'SCREENSHOT'] : ['DOM'],
      },
    ],
    budget: { timeoutMs: 60_000, maxActions: 20 },
  };
}

/** WebSocket 协议夹具；模拟节点结果和故障，不运行浏览器或 systemd。 */
export class SimulatedNode {
  readonly id = randomUUID();
  readonly epoch = randomUUID();
  token = '';
  socket!: WebSocket;
  heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /** 已登记会话与命令计数用于独立检查重复派发。 */
  sessions = new Map<string, NodeCommand>();
  results = new Map<string, Record<string, unknown>>();
  calls = new Map<string, number>();
  ignoreClose = false;
  unknownWrite = false;
  /** 仅供网络协议测试启用；记录仍由夹具生成。 */
  networkEvidence = false;
  /** 默认支持登录快照协议；不证明真实 Cookie 的业务有效性。 */
  authState = true;
  /** 模拟确定未写入的保存故障，供人工完成流程回归使用。 */
  authSaveFailure = false;
  /** 测试显式开启 TRACE 能力，验证调度不会向旧节点下发新操作。 */
  trace = false;
  /** 只用于验证画面协议和通道清理，不代表真实浏览器画面。 */
  readonly relays = new Set<WebSocket>();

  constructor(
    readonly base: string,
    readonly pool: string,
    readonly capacity = 1,
  ) {}

  /** 通过真实注册 HTTP 接口取得机器凭据。 */
  async pair(admin: string): Promise<void> {
    const enrollment = await fetch(`${this.base}/v1/node-pairings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${admin}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: 'node.enroll',
        pool: this.pool,
        name: '测试节点',
      }),
    }).then((r) => r.json());
    const pairing = await fetch(`${this.base}/v1/nodes/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'node.pair',
        nodeId: this.id,
        pool: this.pool,
        pairingToken: enrollment.pairingToken,
      }),
    }).then((r) => r.json());
    if (!pairing.token) throw new Error(JSON.stringify(pairing));
    this.token = pairing.token;
    await this.connect();
  }

  /** 重连沿用进程身份，允许控制面从已保存命令中恢复。 */
  async connect(): Promise<void> {
    this.socket = new WebSocket(
      `${this.base.replace(/^http/, 'ws')}/v1/nodes/connect`,
      { headers: { authorization: `Bearer ${this.token}` } },
    );
    this.socket.on('message', (raw) => {
      const command = JSON.parse(raw.toString());
      if (command.type === 'ack') return;
      if (command.type === 'hitl.attach' || command.type === 'live.attach') {
        const relay = new WebSocket(
          `${this.base.replace(/^http/, 'ws')}/v1/${command.type === 'live.attach' ? 'live' : 'hitl'}/relay`,
          { headers: { authorization: `Bearer ${this.token}` } },
        );
        this.relays.add(relay);
        relay.on('error', () => relay.terminate());
        relay.on('close', () => this.relays.delete(relay));
        relay.on('open', () => {
          relay.send(
            JSON.stringify({
              type: 'attach',
              streamId: command.streamId,
              nodeEpoch: this.epoch,
            }),
          );
          relay.send(
            JSON.stringify({
              type: 'frame',
              data: PNG.toString('base64'),
              metadata: { deviceWidth: 640, deviceHeight: 480 },
            }),
          );
        });
        return;
      }
      this.execute(command);
    });
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.heartbeat();
    const timer = setInterval(() => this.heartbeat(), 200);
    this.heartbeatTimer = timer;
    this.socket.once('close', () => clearInterval(timer));
  }

  /** 心跳携带真实协议字段，允许测试租约和容量策略。 */
  heartbeat(): void {
    this.send({
      type: 'node.heartbeat',
      protocolVersion: '0.1',
      nodeId: this.id,
      nodeEpoch: this.epoch,
      pool: this.pool,
      leaseRequestId: randomUUID(),
      capacity: this.capacity,
      limits: { maxLeaseMs: 60_000, maxSessionMs: 3_600_000 },
      occupied: [...this.sessions.values()].map((c) => ({
        sessionId: c.sessionId,
        leaseId: c.leaseId,
        fence: c.fence,
        state: 'ACTIVE',
      })),
      capabilities: {
        observe: true,
        screenshot: true,
        conditionWait: true,
        writeActions: true,
        engineWritesVerified: false,
        networkEvidence: this.networkEvidence,
        authState: this.authState,
        liveView: true,
        trace: this.trace,
      },
    });
  }

  /** 只模拟结构化操作，故意保留等待命令以触发取消和超时路径。 */
  execute(command: NodeCommand): void {
    if (this.results.has(command.commandId)) {
      this.send(this.results.get(command.commandId));
      return;
    }
    this.calls.set(
      command.commandId,
      (this.calls.get(command.commandId) ?? 0) + 1,
    );
    const kind = command.command.type;
    if (kind === 'session.open') this.sessions.set(command.sessionId, command);
    if (kind === 'browser.wait') return;
    if (kind === 'session.close') {
      if (this.ignoreClose) return;
      this.closed(command.sessionId);
    }
    const { command: operation, timeoutMs: _, ...identity } = command;
    const data: Record<string, unknown> =
      kind === 'session.close' ? { state: 'CLOSED' } : {};
    if (kind === 'browser.auth.save') Object.assign(data, { saved: true });
    if (kind === 'browser.observe') {
      if (this.networkEvidence)
        data.network = {
          requests: [
            { url: 'http://127.0.0.1/fixture', method: 'GET', status: 200 },
          ],
          truncated: false,
          redacted: true,
          complete: false,
          scope: 'since_previous_observation',
        };
      Object.assign(data, {
        observationId: randomUUID(),
        text: '测试页面',
        targets: [],
        url: 'http://127.0.0.1/fixture',
        title: 'Fixture',
        atomic: false,
      });
      if (operation.type === 'browser.observe' && operation.screenshot)
        data.artifactRefs = [
          {
            artifactId: randomUUID(),
            kind: 'SCREENSHOT',
            sha256: PNG_HASH,
            status: 'PENDING',
          },
        ];
    }
    if (operation.type === 'browser.trace' && operation.action === 'stop')
      data.artifactRefs = [
        {
          artifactId: randomUUID(),
          kind: 'TRACE',
          sha256: TRACE_HASH,
          status: 'PENDING',
        },
      ];
    const saveFailed = this.authSaveFailure && kind === 'browser.auth.save';
    const unknown = this.unknownWrite && kind === 'browser.act';
    const result = {
      ...identity,
      type: 'command.result',
      messageId: command.commandId,
      operationStatus: saveFailed
        ? 'FAILED'
        : unknown
          ? 'UNKNOWN'
          : 'SUCCEEDED',
      effect: saveFailed
        ? 'NOT_STARTED'
        : unknown
          ? 'MAY_HAVE_HAPPENED'
          : 'COMPLETED',
      data,
    };
    this.results.set(command.commandId, result);
    this.send(result);
  }

  /** 模拟可核实关闭；其证据只用于协议测试，不代表真实进程已经终止。 */
  closed(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.send({
      type: 'session.closed',
      messageId: `session:${sessionId}:CLOSED`,
      sessionId,
      nodeEpoch: session.nodeEpoch,
      leaseId: session.leaseId,
      fence: session.fence,
      state: 'CLOSED',
      closureVerified: true,
    });
  }

  send(value: unknown): void {
    if (this.socket.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(value));
  }
  close(): void {
    clearInterval(this.heartbeatTimer);
    for (const relay of this.relays) relay.terminate();
    this.socket?.terminate();
  }
}
