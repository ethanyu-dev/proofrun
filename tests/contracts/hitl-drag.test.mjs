import assert from 'node:assert/strict';
import test from 'node:test';
import { validateHitlClient } from '../../contracts/dist/index.js';

// 范围：人工拖动可通过共享协议，轨迹数量、坐标、时长和额外字段有界；时间顺序由节点验证，不执行真实浏览器。
test('HITL 拖动轨迹有界且不接受额外脚本字段', () => {
  const first = { x: 100.5, y: 200, atMs: 0 };
  const last = { x: 300, y: 200, atMs: 1000 };
  const message = (points) => ({
    type: 'command',
    commandId: 'manual-drag',
    command: { type: 'browser.input', action: 'drag', points },
  });
  assert.equal(validateHitlClient(message([first, last])), true);
  for (const points of [
    [first],
    Array(257).fill(first),
    [first, { ...last, x: -1 }],
    [first, { ...last, y: 16385 }],
    [first, { ...last, atMs: 8001 }],
    [first, { ...last, script: 'unexpected' }],
  ]) {
    assert.equal(validateHitlClient(message(points)), false);
  }
});
