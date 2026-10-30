import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** 与 Web 发布镜像相同的 Caddy；上游仅回显用于验证的两个无凭据来源头。 */
const IMAGE =
  'caddy:2-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b';
const execute = promisify(execFile);
const docker = async (...args) =>
  (await execute('docker', args, { timeout: 60_000 })).stdout.trim();

// 范围：真实 Caddy 配置跨层保留来源头；上游为夹具，不证明 Railway/Cloudflare 的线上重写契约。
test(
  'Railway Web 代理保留边缘地址和 CDN 客户端地址',
  { timeout: 90_000 },
  async (t) => {
    const upstream = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          real: request.headers['x-real-ip'],
          cdn: request.headers['cf-connecting-ip'],
        }),
      );
    });
    upstream.listen(0, '0.0.0.0');
    await once(upstream, 'listening');
    const name = `proofrun-client-ip-${randomUUID()}`;
    t.after(async () => {
      await docker('rm', '-f', name).catch(() => {});
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
    });
    await docker(
      'run',
      '-d',
      '--name',
      name,
      '--add-host',
      'host.docker.internal:host-gateway',
      '-p',
      '127.0.0.1::8080',
      '-e',
      `PROOFRUN_API_UPSTREAM=host.docker.internal:${upstream.address().port}`,
      '-v',
      `${fileURLToPath(new URL('../../deploy/railway/Caddyfile', import.meta.url))}:/etc/caddy/Caddyfile:ro`,
      IMAGE,
      'caddy',
      'run',
      '--config',
      '/etc/caddy/Caddyfile',
      '--adapter',
      'caddyfile',
    );
    const binding = await docker('port', name, '8080');
    const base = `http://${binding}`;
    const deadline = Date.now() + 20_000;
    while (true) {
      try {
        if ((await fetch(`${base}/health/ready`)).ok) break;
      } catch {}
      if (Date.now() > deadline) assert.fail('Caddy 启动超时');
      await delay(100);
    }
    for (const [real, cdn] of [
      ['104.21.68.37', '198.51.100.8'],
      ['2606:4700::1', '2001:db8::8'],
    ]) {
      const response = await fetch(`${base}/v1/admin/console-login`, {
        method: 'POST',
        headers: {
          'x-real-ip': real,
          'cf-connecting-ip': cdn,
          'x-forwarded-for': '192.0.2.99',
        },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { real, cdn });
    }
  },
);
