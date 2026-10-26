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
const bootstrap = await fetch(`${base}/v1/hitl/bootstrap`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: base },
  body: JSON.stringify({ id: link.id, token: link.path.split('/').at(-1) }),
}).then(async (response) => {
  assert.equal(response.status, 200);
  return response.json();
});
assert.ok(bootstrap.direct);
assert.equal(bootstrap.state.runtimeEvidenceAvailable, true);
assert(
  Date.parse(bootstrap.state.waitDeadline) <=
    Date.parse(bootstrap.state.expiresAt),
);
// 范围：真实节点拒绝错误 Origin，失败认证不消费合法连接凭据；不验证公网证书。
const unauthorized = new WebSocket(bootstrap.direct.controlUrl, {
  origin: 'https://wrong.example.test',
});
const denied = new Promise((resolve, reject) => {
  unauthorized.once('message', (raw) => resolve(JSON.parse(raw.toString())));
  unauthorized.once('error', reject);
  unauthorized.once('open', () =>
    unauthorized.send(
      JSON.stringify({
        type: 'authenticate',
        nodeId: bootstrap.direct.nodeId,
        id: bootstrap.direct.id,
        token: bootstrap.direct.token,
      }),
    ),
  );
});
assert.equal((await denied).code, 'HITL_INVALID');
unauthorized.terminate();

const socket = new WebSocket(bootstrap.direct.controlUrl, { origin: base });
let frames;
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
      nodeId: bootstrap.direct.nodeId,
      id: bootstrap.direct.id,
      token: bootstrap.direct.token,
    }),
  );
  await until(() => messages.find((m) => m.type === 'state'));
  frames = new WebSocket(bootstrap.direct.frameUrl, { origin: base });
  frames.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  frames.on('open', () =>
    frames.send(
      JSON.stringify({
        type: 'authenticate',
        nodeId: bootstrap.direct.nodeId,
        id: bootstrap.direct.id,
        token: bootstrap.direct.token,
      }),
    ),
  );
  frames.on('error', (error) =>
    messages.push({ type: 'error', message: String(error) }),
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
  // 范围：真实同会话只读探针返回独立证据；不自动勾选或宣称网站通过。
  const probeId = randomUUID();
  socket.send(
    JSON.stringify({
      type: 'command',
      commandId: probeId,
      command: { type: 'browser.observe', screenshot: false },
    }),
  );
  const probe = await until(() =>
    messages.find((m) => m.type === 'result' && m.commandId === probeId),
  );
  assert.equal(probe.status, 'SUCCEEDED', JSON.stringify(probe));
  assert.equal(probe.evidence.runtime.status, 'observed');
  assert.equal(probe.evidence.runtime.cacheStorage.status, 'observed');
  assert.equal(probe.evidence.network.scope, 'tab-navigation');
  socket.send(
    JSON.stringify({
      type: 'complete',
      confirmedItems: bootstrap.state.items.map((_, i) => i),
      ...(bootstrap.state.conditionKeys
        ? { confirmedConditionKeys: bootstrap.state.conditionKeys }
        : {}),
    }),
  );
  await until(() => messages.find((m) => m.type === 'completed'));
  // 范围：交还后的只读 Live 也直连原节点，读取帧后尝试输入会被关闭，不产生业务提交。
  const viewing = await fetch(
    `${base}/v1/admin/executions/${process.env.PROOFRUN_HITL_EXECUTION}/live`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.PROOFRUN_HITL_ADMIN}` },
    },
  ).then(async (response) => {
    assert.equal(response.status, 200);
    return response.json();
  });
  const viewer = new WebSocket(viewing.url, { origin: base });
  try {
    await new Promise((resolve, reject) => {
      viewer.once('error', reject);
      viewer.once('message', (raw) => {
        assert.equal(JSON.parse(raw.toString()).type, 'frame');
        resolve();
      });
      viewer.once('open', () =>
        viewer.send(
          JSON.stringify({
            type: 'authenticate',
            nodeId: viewing.nodeId,
            id: viewing.id,
            token: viewing.token,
          }),
        ),
      );
    });
    const closed = new Promise((resolve) => viewer.once('close', resolve));
    viewer.send(
      JSON.stringify({
        type: 'command',
        commandId: randomUUID(),
        command: { type: 'browser.input', action: 'press', value: 'Enter' },
      }),
    );
    await closed;
  } finally {
    viewer.terminate();
  }

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
  frames?.terminate();
}
