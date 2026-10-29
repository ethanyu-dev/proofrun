import { EventEmitter } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { benchmarkConsole } from '../../scripts/benchmarks/console-plugin.mjs';

// 范围：本地 HTTP 中间件拒绝跨源、DNS rebinding 与非 JSON 启动；不启动子进程，不证明生产代理配置。
test('开发态运行接口只接受回环同源请求，拒绝跨站运行与读取', async (t) => {
  let handler;
  const server = createServer((request, response) =>
    handler(request, response, () => response.writeHead(404).end()),
  );
  const starts = [];
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  benchmarkConsole({
    spawnProcess: (...args) => {
      starts.push(args);
      return child;
    },
  }).configureServer({
    httpServer: server,
    middlewares: {
      use(value) {
        handler = value;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}`;
  for (const headers of [
    { Origin: 'https://untrusted.test', 'Content-Type': 'application/json' },
    { Origin: url, 'Content-Type': 'text/plain' },
    { 'Content-Type': 'application/json' },
    { Origin: url, 'Content-Type': 'application/json', Host: 'untrusted.test' },
  ]) {
    // 原生 HTTP 保留测试指定的 Host；fetch 会重写该受控头，无法模拟 DNS rebinding。
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(
        `${url}/__benchmark`,
        { method: 'POST', headers },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
      request.end('{}');
    });
    assert.equal(status, 403, JSON.stringify(headers));
  }
  assert.equal(
    (
      await fetch(`${url}/__benchmark`, {
        headers: { Origin: 'https://untrusted.test' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(`${url}/__benchmark`, { method: 'DELETE' })).status,
    405,
  );
  assert.equal((await fetch(`${url}/unrelated`)).status, 404);
  // 范围：有能力缺口仍可重跑，子进程为替身，不触发真实模型消费或浏览器会话。
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = await fetch(`${url}/__benchmark`, {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'v2', version: 'partial-test' }),
    });
    assert.equal(started.status, 202);
    assert.equal((await started.json()).running, true);
    const busy = await fetch(`${url}/__benchmark`, {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'v2' }),
    });
    assert.equal(busy.status, 409);
    child.emit('close', 1);
  }
  assert.equal(starts.length, 2);
  assert.equal(starts[0][0], 'pnpm');
  assert.equal(starts[0][1][0], 'benchmark:v2');
  const preview = await fetch(`${url}/__benchmark?family=v2`).then((response) =>
    response.json(),
  );
  assert.equal(preview.running, false);
  assert.equal(preview.preflight, undefined);
});
