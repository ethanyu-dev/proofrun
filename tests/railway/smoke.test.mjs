import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** 容器创建有界；仅使用事先构建的本项目测试标签。 */
const execute = promisify(execFile);
const TIMEOUT_MS = 30_000;
/** 固定参数数组调用 Docker，不让配置进入 shell 求值。 */
const docker = async (...args) =>
  (
    await execute('docker', args, { timeout: 60_000, maxBuffer: 1024 * 1024 })
  ).stdout.trim();
/** 等待数据库或代理启动；不会修改任务租约或隐式重试业务提交。 */
async function ready(read) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    try {
      if (await read()) return;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error('Railway 镜像启动超时', { cause: last });
}

// 范围：真实三个发布镜像、私网代理、PORT、profile 变量、迁移、持久卷和 worker 轮询。
// 不调用供应商模型或业务浏览器；不代表 Railway 账号中的域名、Volume 和变量已经配置。
test(
  'Railway 镜像通过同源入口提供控制面与 worker',
  { timeout: 120_000 },
  async (t) => {
    const id = `proofrun-railway-${randomUUID().slice(0, 8)}`;
    const pg = `${id}-pg`,
      api = `${id}-api`,
      web = `${id}-web`,
      agent = `${id}-agent`,
      volume = `${id}-data`;
    const admin = randomUUID(),
      worker = randomUUID(),
      password = randomUUID();
    const label = `proofrun.railway-test=${id}`;
    t.after(async () => {
      const names = (await docker('ps', '-aq', '--filter', `label=${label}`))
        .split('\n')
        .filter(Boolean);
      if (names.length) await docker('rm', '-f', ...names);
      await docker('network', 'rm', id);
      await docker('volume', 'rm', volume);
    });
    await docker('network', 'create', id);
    await docker('volume', 'create', volume);
    await docker(
      'run',
      '-d',
      '--name',
      pg,
      '--label',
      label,
      '--network',
      id,
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      'POSTGRES_DB=proofrun',
      'postgres:17',
    );
    await ready(async () => {
      await docker(
        'exec',
        pg,
        'pg_isready',
        '-U',
        'postgres',
        '-d',
        'proofrun',
      );
      return true;
    });
    const profile = await readFile(
      new URL('../../deploy/case-profile.example.json', import.meta.url),
      'utf8',
    );
    /** 使用两个不同 PORT，验证对外代理与私网 API 都遵守平台分配的监听端口。 */
    const startApi = () =>
      docker(
        'run',
        '-d',
        '--name',
        api,
        '--label',
        label,
        '--network',
        id,
        '--network-alias',
        'api',
        '-v',
        `${volume}:/data`,
        '-e',
        'PORT=4301',
        '-e',
        `PROOFRUN_DATABASE_URL=postgresql://postgres:${password}@${pg}:5432/proofrun`,
        '-e',
        `PROOFRUN_ADMIN_TOKEN=${admin}`,
        '-e',
        `PROOFRUN_WORKER_TOKEN=${worker}`,
        '-e',
        'PROOFRUN_PUBLIC_URL=https://proofrun.example.test',
        '-e',
        `PROOFRUN_CASE_PROFILE_JSON=${profile}`,
        'proofrun-railway-api:test',
      );
    await startApi();
    await docker(
      'run',
      '-d',
      '--name',
      web,
      '--label',
      label,
      '--network',
      id,
      '-p',
      '127.0.0.1::4302',
      '-e',
      'PORT=4302',
      '-e',
      'PROOFRUN_API_UPSTREAM=api:4301',
      'proofrun-railway-web:test',
    );
    const base = `http://${await docker('port', web, '4302/tcp')}`;
    await ready(async () => {
      const r = await fetch(`${base}/health/ready`);
      return r.ok && (await r.json()).status === 'ready';
    });
    for (const path of ['/v1/tasks', '/v2/cases/fixture']) {
      const rejected = await fetch(base + path);
      assert.equal(rejected.status, 401);
      assert.match(rejected.headers.get('content-type'), /application\/json/);
      await rejected.json();
    }
    const page = await fetch(`${base}/tasks/fixture`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/);
    const cases = JSON.parse(
      await readFile(
        new URL(
          '../../contracts/examples/public-api/cases-v2.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const submitted = await fetch(`${base}/v2/cases`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${admin}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(cases),
    });
    assert.equal(submitted.status, 202, await submitted.text());
    // 无节点可领取，worker once 仅验证镜像配置与 API 协议，不访问模型地址。
    const once = await docker(
      'run',
      '--rm',
      '--label',
      label,
      '--network',
      id,
      '-e',
      'PROOFRUN_CONTROL_URL=http://api:4301',
      '-e',
      `PROOFRUN_WORKER_TOKEN=${worker}`,
      '-e',
      'PROOFRUN_MODEL_BASE_URL=http://127.0.0.1:9/v1',
      '-e',
      'PROOFRUN_MODEL_API_KEY=fixture-only',
      '-e',
      'PROOFRUN_MODEL=fixture',
      'proofrun-railway-agent:test',
      'node',
      'dist/main.js',
      'once',
    );
    assert.match(once, /queue.empty/);
    // 用真实配对凭据验证代理返回 101；不发送节点心跳或浏览器结果，不触发任务执行。
    const enrollment = await fetch(`${base}/v1/node-pairings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${admin}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        type: 'node.enroll',
        pool: 'isolated-proxy-test',
        name: '代理夹具',
      }),
    }).then((r) => r.json());
    const paired = await fetch(`${base}/v1/nodes/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'node.pair',
        nodeId: randomUUID(),
        pool: 'isolated-proxy-test',
        pairingToken: enrollment.pairingToken,
      }),
    }).then((r) => r.json());
    assert.ok(paired.token);
    const handshake = await new Promise((resolve, reject) => {
      const req = request(`${base}/v1/nodes/connect`, {
        headers: {
          authorization: `Bearer ${paired.token}`,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        },
      });
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode);
      });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('WebSocket 升级超时')));
      req.end();
    });
    assert.equal(handshake, 101);
    await docker(
      'exec',
      api,
      'node',
      '-e',
      "require('node:fs').mkdirSync('/data/artifacts',{recursive:true});require('node:fs').writeFileSync('/data/artifacts/persist-fixture','retained')",
    );
    await docker('stop', '-t', '10', api);
    assert.equal(
      await docker('inspect', '--format', '{{.State.ExitCode}}', api),
      '0',
    );
    await docker('rm', api);
    await startApi();
    await ready(async () => {
      const r = await fetch(`${base}/health/ready`);
      await r.text();
      return r.ok;
    });
    assert.equal(
      await docker('exec', api, 'cat', '/data/artifacts/persist-fixture'),
      'retained',
    );
    const listed = await fetch(`${base}/v1/tasks`, {
      headers: { authorization: `Bearer ${admin}` },
    });
    assert.equal(listed.status, 200);
    const data = await listed.json();
    assert.ok(data.tasks.length > 0);
  },
);
