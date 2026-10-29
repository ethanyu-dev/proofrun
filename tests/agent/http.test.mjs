import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { modelTransport } from '../../apps/agent/dist/model/transport.js';
import {
  AgentFault,
  jsonRequest,
  transient,
} from '../../apps/agent/dist/http.js';

/** 超过 Node 默认十秒连接时限，直接覆盖曾经提前中止的 TLS 建连路径。 */
const MODEL_CONNECTION_TEST_MS = 11_500;

/** TCP 接通后读取但不回复 TLS 握手；用于确定性模拟慢建连，不访问真实供应商。 */
async function stalledTls() {
  const sockets = new Set();
  let connections = 0;
  const server = createTcpServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.resume();
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    url: `https://127.0.0.1:${server.address().port}`,
    connections: () => connections,
    async assertReleased() {
      const deadline = performance.now() + 1000;
      while (sockets.size && performance.now() < deadline) await delay(10);
      assert.equal(sockets.size, 0, '请求结束后不能遗留正在握手的连接');
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// 范围：本地真实 TCP/TLS 等待超过默认十秒后遵守已有请求期限，无重连且释放 socket；不证明远端网络质量。
test('模型慢建连使用请求剩余期限，不被隐含十秒配置提前截断', async () => {
  const fixture = await stalledTls();
  try {
    const started = performance.now();
    await assert.rejects(
      jsonRequest(
        fixture.url,
        'fixture',
        'POST',
        {},
        MODEL_CONNECTION_TEST_MS,
        undefined,
        undefined,
        modelTransport,
      ),
      { code: 'TRANSPORT_REQUEST_TIMEOUT' },
    );
    const elapsed = performance.now() - started;
    assert.ok(
      elapsed >= MODEL_CONNECTION_TEST_MS - 100,
      `提前结束：${elapsed}`,
    );
    assert.ok(
      elapsed < MODEL_CONNECTION_TEST_MS + 3000,
      `超出期限：${elapsed}`,
    );
    assert.equal(fixture.connections(), 1);
    await fixture.assertReleased();
  } finally {
    await fixture.close();
  }
});

// 范围：取消发生在 TLS 建连中时立刻关闭连接且保留租约错误；不等待完整模型时限，不验证远端服务取消计算。
test('模型握手期间取消会关闭在途连接，已经取消的调用不建连', async () => {
  const fixture = await stalledTls();
  const controller = new AbortController();
  const reason = new AgentFault('LEASE_LOST', '租约失效');
  try {
    const connected = once(fixture.server, 'connection');
    const request = jsonRequest(
      fixture.url,
      'fixture',
      'POST',
      {},
      30_000,
      controller.signal,
      undefined,
      modelTransport,
    );
    const rejected = assert.rejects(request, (error) => error === reason);
    await connected;
    controller.abort(reason);
    await rejected;
    await fixture.assertReleased();
    await assert.rejects(
      jsonRequest(
        fixture.url,
        'fixture',
        'POST',
        {},
        30_000,
        controller.signal,
        undefined,
        modelTransport,
      ),
      (error) => error === reason,
    );
    assert.equal(fixture.connections(), 1);
  } finally {
    await fixture.close();
  }
});

// 范围：并行本地 HTTP 请求分别遵守自己的取消信号与响应；不测供应商并发限流或真实模型。
test('取消一个模型请求不会影响其他任务的连接', async () => {
  const server = createServer((request, response) => {
    request.resume();
    if (request.url === '/complete') response.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  const reason = new AgentFault('LEASE_LOST', '租约失效');
  try {
    const received = once(server, 'request');
    const pending = assert.rejects(
      jsonRequest(
        `${url}/pending`,
        'fixture',
        'POST',
        {},
        3000,
        controller.signal,
        undefined,
        modelTransport,
      ),
      (error) => error === reason,
    );
    await received;
    const complete = jsonRequest(
      `${url}/complete`,
      'fixture',
      'POST',
      {},
      3000,
      undefined,
      undefined,
      modelTransport,
    );
    controller.abort(reason);
    await pending;
    assert.deepEqual(await complete, { ok: true });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

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
