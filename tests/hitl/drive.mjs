import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
);
const WebSocket = require('ws');
/** 协议客户端模拟处理者；真实画面及输入由远端 Rust/Chromium 提供，不验证 UI 排版。 */
const base = process.env.PROOFRUN_HITL_BASE;
const link = JSON.parse(process.env.PROOFRUN_HITL_LINK);
const socket = new WebSocket(base.replace(/^http/, 'ws') + '/v1/hitl/connect', {
  origin: base,
});
const messages = [];
/** JPEG 帧头中的尺寸来自真实编码结果，不能用流元数据自证视口正确。 */
function jpegSize(data) {
  const bytes = Buffer.from(data, 'base64');
  assert.equal(bytes.readUInt16BE(0), 0xffd8);
  for (let offset = 2; offset + 9 < bytes.length;) {
    assert.equal(bytes[offset], 0xff);
    const marker = bytes[offset + 1];
    if ([0xc0, 0xc1, 0xc2].includes(marker))
      return {
        width: bytes.readUInt16BE(offset + 7),
        height: bytes.readUInt16BE(offset + 5),
      };
    const length = bytes.readUInt16BE(offset + 2);
    assert.ok(length >= 2);
    offset += length + 2;
  }
  throw new Error('JPEG 缺少可验证的尺寸');
}
socket.on('message', (value) => messages.push(JSON.parse(value.toString())));
const until = async (predicate) => {
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    const error = messages.find((m) => m.type === 'error');
    if (error) throw new Error(JSON.stringify(error));
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    'HITL wait timeout ' + JSON.stringify(messages.map((m) => m.type)),
  );
};
try {
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(
    JSON.stringify({
      type: 'authenticate',
      id: link.id,
      token: link.path.split('/').at(-1),
    }),
  );
  const frame = await until(() => messages.find((m) => m.type === 'frame'));
  assert.equal(
    Buffer.from(frame.data, 'base64').subarray(0, 2).toString('hex'),
    'ffd8',
  );
  assert.ok(frame.width > 0 && frame.height > 0);
  // 范围：真实 JPEG、流坐标与显式视口一致；不替代前端 CSS 排版或飞书扫码验收。
  assert.deepEqual(jpegSize(frame.data), {
    width: frame.width,
    height: frame.height,
  });
  assert.deepEqual(jpegSize(frame.data), { width: 1280, height: 720 });
  for (const operation of [
    // 模拟缩放后的非整数坐标，避免 JSON 浮点值直接传入只接受整数的 CLI。
    { action: 'click', x: 120.4, y: 90.2 },
    { action: 'text', value: '--cdp HITL中文' },
    { action: 'press', value: 'Tab' },
    { action: 'press', value: 'Enter' },
  ]) {
    const commandId = randomUUID();
    socket.send(
      JSON.stringify({
        type: 'command',
        commandId,
        command: { type: 'browser.input', ...operation },
      }),
    );
    const result = await until(() =>
      messages.find((m) => m.type === 'result' && m.commandId === commandId),
    );
    assert.equal(result.status, 'SUCCEEDED', JSON.stringify(result));
  }
  socket.send(JSON.stringify({ type: 'complete' }));
  await until(() => messages.find((m) => m.type === 'completed'));
  console.log(
    JSON.stringify({
      frames: messages.filter((m) => m.type === 'frame').length,
      inputs: 4,
      viewport: jpegSize(frame.data),
      completed: true,
    }),
  );
} finally {
  socket.terminate();
}
