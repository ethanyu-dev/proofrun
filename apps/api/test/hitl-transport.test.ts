import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { EventEmitter, once } from 'node:events';
import type { HitlServer } from '@proofrun/contracts';
import {
  discardFrame,
  sendStreamMessage,
} from '../src/modules/hitl/transport.js';

/** 仅模拟发送背压；不使用真实网络或声称验证了 TLS 与带宽。 */
function socket(bufferedAmount: number) {
  const sent: HitlServer[] = [];
  const stub = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN as number,
    bufferedAmount,
    terminated: false,
    send(value: string) {
      sent.push(JSON.parse(value));
    },
    terminate() {
      this.terminated = true;
      this.readyState = WebSocket.CLOSED;
      stub.emit('close');
    },
  });
  return { stub, sent, socket: stub as unknown as WebSocket };
}

// 范围：同一积压下画面可丢弃但成功回执与完成通知必须送出；不模拟客户端渲染。
test('画面背压不能静默丢失操作回执', () => {
  const f = socket(2 * 1024 * 1024);
  sendStreamMessage(f.socket, {
    type: 'frame',
    data: 'fixture',
    width: 1280,
    height: 720,
  });
  const result: HitlServer = {
    type: 'result',
    commandId: 'fixture-command',
    status: 'SUCCEEDED',
    effect: 'APPLIED',
  };
  sendStreamMessage(f.socket, result);
  sendStreamMessage(f.socket, { type: 'completed' });
  assert.deepEqual(f.sent, [result, { type: 'completed' }]);
  assert.equal(f.stub.terminated, false);
  discardFrame(f.socket);
});

// 范围：延迟帧不得越过撤权/关闭，新帧不得被旧缓存覆盖；不模拟浏览器截图内容。
test('撤权和新画面清理旧缓存', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (const action of ['revoke', 'close', 'new-frame']) {
    const f = socket(2 * 1024 * 1024);
    sendStreamMessage(f.socket, {
      type: 'frame',
      data: 'old',
      width: 1,
      height: 1,
    });
    f.stub.bufferedAmount = 0;
    if (action === 'revoke') discardFrame(f.socket);
    else if (action === 'close') f.stub.terminate();
    else
      sendStreamMessage(f.socket, {
        type: 'frame',
        data: 'new',
        width: 1,
        height: 1,
      });
    t.mock.timers.tick(100);
    assert.equal(f.sent.length, action === 'new-frame' ? 1 : 0);
    if (action === 'new-frame')
      assert.equal((f.sent[0] as { data: string }).data, 'new');
    assert.equal(f.stub.listenerCount('close'), 0);
  }
});

// 范围：持续积压不能永久保留可操作的旧图，单帧超限也不能无限重试；不验证真实网络超时。
test('画面持续阻塞或单帧超限时断线', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = socket(2 * 1024 * 1024);
  sendStreamMessage(f.socket, {
    type: 'frame',
    data: 'latest',
    width: 1,
    height: 1,
  });
  t.mock.timers.tick(5000);
  assert.equal(f.stub.terminated, true);
  assert.deepEqual(f.sent, []);
  const large = socket(0);
  sendStreamMessage(large.socket, {
    type: 'frame',
    data: 'a'.repeat(2 * 1024 * 1024),
    width: 1,
    height: 1,
  });
  assert.equal(large.stub.terminated, true);
});

// 范围：持续积压超过控制消息预留时主动断线；不验证 WebSocket 实际关闭传播时间。
test('控制消息也无法发送时明确断线而非无限等待', () => {
  const f = socket(2 * 1024 * 1024 + 64 * 1024);
  sendStreamMessage(f.socket, { type: 'completed' });
  assert.equal(f.stub.terminated, true);
  assert.deepEqual(f.sent, []);
});

// 范围：弹窗关闭后的最后一帧遇到背压，队列排空后仍应送出；模拟缓冲状态，不代表海外网络验收。
test('页面停止重绘后仍补发最新画面，操作回执不被画面阻塞', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = socket(2 * 1024 * 1024);
  const frame = (data: string): HitlServer => ({
    type: 'frame',
    data,
    width: 1280,
    height: 720,
  });
  sendStreamMessage(f.socket, frame('old-popup'));
  sendStreamMessage(f.socket, frame('popup-closed'));
  const result: HitlServer = {
    type: 'result',
    commandId: 'click',
    status: 'SUCCEEDED',
    effect: 'COMPLETED',
  };
  sendStreamMessage(f.socket, result);
  assert.deepEqual(f.sent, [result]);
  f.stub.bufferedAmount = 0;
  t.mock.timers.tick(100);
  assert.deepEqual(f.sent, [result, frame('popup-closed')]);
  t.mock.timers.tick(1000);
  assert.equal(f.sent.length, 2);
});

// 范围：真实回环 WebSocket 暂停读取形成积压，恢复后无需新帧即可收到最终画面；不替代公网/TLS 验收。
test('真实连接排空后收到静态页面的最后一帧', { timeout: 10000 }, async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const accepted = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
  t.after(() => {
    client.terminate();
    for (const socket of server.clients) socket.terminate();
    server.close();
  });
  await once(client, 'open');
  const [peer] = (await accepted) as [WebSocket];
  client.pause();
  const padding = 'x'.repeat(512 * 1024);
  for (let i = 0; i < 32 && peer.bufferedAmount < 2 * 1024 * 1024; i++)
    peer.send(padding);
  assert.ok(peer.bufferedAmount >= 2 * 1024 * 1024);
  const final = new Promise<HitlServer>((resolve) => {
    client.on('message', (bytes) => {
      const text = bytes.toString();
      if (text.startsWith('{')) resolve(JSON.parse(text));
    });
  });
  sendStreamMessage(peer, {
    type: 'frame',
    data: 'popup-open',
    width: 1,
    height: 1,
  });
  const expected: HitlServer = {
    type: 'frame',
    data: 'popup-closed',
    width: 1,
    height: 1,
  };
  sendStreamMessage(peer, expected);
  client.resume();
  assert.deepEqual(await final, expected);
});
