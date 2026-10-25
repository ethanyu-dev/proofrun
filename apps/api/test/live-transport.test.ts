import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { Database } from '../src/db.js';
import type { NodeGateway } from '../src/modules/nodes/gateway.js';
import { LiveService } from '../src/modules/hitl/live.js';

/** 只模拟传输缓冲与消息事件；不建立真实浏览器或网络连接。 */
function connection() {
  const sent: Array<Record<string, unknown>> = [];
  const stub = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send(value: string) {
      sent.push(JSON.parse(value));
    },
    close() {
      this.readyState = WebSocket.CLOSED;
      stub.emit('close');
    },
    terminate() {
      this.close();
    },
  });
  return { stub, sent, socket: stub as unknown as WebSocket };
}

/** 等待异步鉴权和状态读取完成，不依赖被模拟的重试计时器。 */
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 模拟一条已获授权的节点流，两个观看者共享帧但各自处理背压。 */
async function fixture() {
  const grant = {
    id: 'execution',
    task_id: 'task',
    node_id: 'node',
    node_epoch: 'epoch',
    session_id: 'session',
    lease_id: 'lease',
    fence: '1',
    task_state: 'RUNNING',
    state: 'RUNNING',
    session_state: 'ACTIVE',
    control_mode: 'AUTO',
    action_count: 0,
    lease_expires_at: new Date(Date.now() + 60_000),
    deadline_at: new Date(Date.now() + 60_000),
  };
  let streamId = '';
  const db = { query: async () => ({ rows: [grant] }) } as unknown as Database;
  const gateway = {
    attach: async (_node: string, value: { streamId: string }) => {
      streamId = value.streamId;
      return true;
    },
  } as unknown as NodeGateway;
  const service = new LiveService(db, gateway, 'fixture-admin');
  const slow = connection();
  const fast = connection();
  for (const viewer of [slow, fast]) {
    service.accept(viewer.socket);
    viewer.stub.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'authenticate',
          token: 'fixture-admin',
          executionId: grant.id,
        }),
      ),
      false,
    );
    await drain();
  }
  assert.ok(streamId);
  const relay = connection();
  service.relay(relay.socket, grant.node_id);
  relay.stub.emit(
    'message',
    Buffer.from(
      JSON.stringify({ type: 'attach', streamId, nodeEpoch: grant.node_epoch }),
    ),
    false,
  );
  const frame = (data: string) =>
    relay.stub.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'frame',
          data,
          metadata: { deviceWidth: 1, deviceHeight: 1 },
        }),
      ),
      false,
    );
  return { service, slow, fast, grant, frame };
}

// 范围：经过 LiveService 真实接入方法验证慢观看者最后一帧补发与快观看者隔离；不验证公网带宽或真实截图。
test('自动观看在页面静止后补发最新帧，不阻塞其他观看者', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const f = await fixture();
  t.after(() => f.service.close());
  f.slow.stub.bufferedAmount = 2 * 1024 * 1024;
  f.frame('b2xk');
  f.frame('bmV3');
  assert.equal(f.slow.sent.filter((value) => value.type === 'frame').length, 0);
  assert.deepEqual(
    f.fast.sent
      .filter((value) => value.type === 'frame')
      .map((value) => value.data),
    ['b2xk', 'bmV3'],
  );
  f.slow.stub.bufferedAmount = 0;
  t.mock.timers.tick(100);
  const frames = f.slow.sent.filter((value) => value.type === 'frame');
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.data, 'bmV3');
  assert.deepEqual(frames[0], f.service.snapshot('execution').frame);
});

// 范围：自动流交给人工时清除待发送帧，避免排空后泄漏旧画面；控制权和数据库使用夹具，不替代 HITL 集成验收。
test('人工接管后不再补发自动流积压画面', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const f = await fixture();
  t.after(() => f.service.close());
  f.slow.stub.bufferedAmount = 2 * 1024 * 1024;
  f.frame('b2xk');
  f.grant.control_mode = 'HUMAN';
  t.mock.timers.tick(750);
  await drain();
  f.slow.stub.bufferedAmount = 0;
  t.mock.timers.tick(100);
  assert.equal(f.slow.sent.filter((value) => value.type === 'frame').length, 0);
  assert.ok(f.slow.sent.some((value) => value.type === 'ended'));
  assert.equal(f.slow.stub.readyState, WebSocket.CLOSED);
});
