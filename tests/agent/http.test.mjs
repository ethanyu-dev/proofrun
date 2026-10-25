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

// 范围：真实 Worker 单轮启动只访问领取接口；HTTP 为空队列夹具，不执行真实任务、模型或 DevPass。
test('Worker 直接领取任务，不依赖已移除的身份选择接口', async () => {
  const { spawn } = await import('node:child_process');
  const calls = [];
  const server = createServer((request, response) => {
    calls.push(request.url);
    request.resume();
    response.writeHead(request.url === '/v1/worker/claim' ? 200 : 404, {
      'content-type': 'application/json',
    });
    response.end(JSON.stringify({ execution: null }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(process.execPath, ['apps/agent/dist/main.js', 'once'], {
      env: {
        ...process.env,
        PROOFRUN_CONTROL_URL: endpoint,
        PROOFRUN_WORKER_TOKEN:
          'worker-fixture-token-with-at-least-32-characters',
        PROOFRUN_MODEL_BASE_URL: endpoint,
        PROOFRUN_MODEL_API_KEY: 'fixture',
        PROOFRUN_MODEL: 'fixture',
        PROOFRUN_AGENT_CONCURRENCY: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    assert.equal(code, 0, output);
    assert.deepEqual(calls, ['/v1/worker/claim']);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
