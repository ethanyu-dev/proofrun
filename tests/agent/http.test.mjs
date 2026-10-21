import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import {
  AgentFault,
  jsonRequest,
  transient,
} from '../../apps/agent/dist/http.js';

// 范围：注入运行时错误验证分类与脱敏，不将模拟错误当作真实网络故障证据。
test('传输错误保留连接阶段分类且不泄露原始异常', async (t) => {
  for (const [cause, expected] of [
    ['UND_ERR_CONNECT_TIMEOUT', 'TRANSPORT_CONNECT_TIMEOUT'],
    ['UND_ERR_HEADERS_TIMEOUT', 'TRANSPORT_RESPONSE_TIMEOUT'],
    ['UND_ERR_BODY_TIMEOUT', 'TRANSPORT_RESPONSE_TIMEOUT'],
    ['ENOTFOUND', 'TRANSPORT_DNS_ERROR'],
    ['ECONNRESET', 'TRANSPORT_CONNECTION_RESET'],
    ['SECRET_TOKEN', 'TRANSPORT_ERROR'],
    ['toString', 'TRANSPORT_ERROR'],
  ]) {
    t.mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('secret-url-and-token', { cause: { code: cause } });
    });
    await assert.rejects(
      jsonRequest('https://fixture.test', 'key', 'POST', {}, 1000),
      (error) => {
        assert.equal(error.code, expected);
        assert.equal(transient(error), true);
        assert.doesNotMatch(error.message, /secret|token|fixture/);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    t.mock.restoreAll();
  }
  assert.equal(transient(new AgentFault('INVALID_JSON', '格式错误')), false);
});

// 范围：本地 HTTP 无响应触发配置期限，外部取消仍保留原原因；不覆盖远端链路或供应商推理。
test('请求期限与外部取消分别记录', async () => {
  const server = createServer((request) => request.resume());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(
      jsonRequest(url, 'key', 'POST', {}, 50),
      (error) => error.code === 'TRANSPORT_REQUEST_TIMEOUT' && transient(error),
    );
    const controller = new AbortController();
    const reason = new AgentFault('LEASE_LOST', '租约失效');
    controller.abort(reason);
    await assert.rejects(
      jsonRequest(url, 'key', 'POST', {}, 1000, controller.signal),
      (error) => error === reason,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
