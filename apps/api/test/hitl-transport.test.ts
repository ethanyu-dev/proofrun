import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import type { HitlServer } from '@proofrun/contracts';
import { sendHitlMessage } from '../src/modules/hitl/transport.js';

/** 仅模拟发送背压；不使用真实网络或声称验证了 TLS 与带宽。 */
function socket(bufferedAmount: number) {
  const sent: HitlServer[] = [];
  const stub = {
    readyState: WebSocket.OPEN,
    bufferedAmount,
    terminated: false,
    send(value: string) {
      sent.push(JSON.parse(value));
    },
    terminate() {
      this.terminated = true;
    },
  };
  return { stub, sent, socket: stub as unknown as WebSocket };
}

// 范围：同一积压下画面可丢弃但成功回执与完成通知必须送出；不模拟客户端渲染。
test('画面背压不能静默丢失操作回执', () => {
  const f = socket(2 * 1024 * 1024);
  sendHitlMessage(f.socket, {
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
  sendHitlMessage(f.socket, result);
  sendHitlMessage(f.socket, { type: 'completed' });
  assert.deepEqual(f.sent, [result, { type: 'completed' }]);
  assert.equal(f.stub.terminated, false);
});

// 范围：持续积压超过控制消息预留时主动断线；不验证 WebSocket 实际关闭传播时间。
test('控制消息也无法发送时明确断线而非无限等待', () => {
  const f = socket(2 * 1024 * 1024 + 64 * 1024);
  sendHitlMessage(f.socket, { type: 'completed' });
  assert.equal(f.stub.terminated, true);
  assert.deepEqual(f.sent, []);
});
