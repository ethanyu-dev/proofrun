import assert from 'node:assert/strict';
import test from 'node:test';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

/** 固定代理镜像摘要，使路由回归不随 latest 标签漂移。 */
const CADDY_IMAGE =
  'caddy:2-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b';
/** 启动轮询有界；只等待临时容器，不延长任务执行租约。 */
const START_TIMEOUT_MS = 30_000;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);

/** 只执行固定 Docker 子命令，参数不经 shell 展开。 */
async function docker(...args) {
  const result = await execute('docker', args, {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

/** 代理和数据库启动期间允许暂时不可达，超时保留最后错误。 */
async function untilReady(read) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let last;
  while (Date.now() < deadline) {
    try {
      if (await read()) return;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error('部署冒烟等待服务就绪超时', { cause: last });
}

// 范围：编译产物、全新 PostgreSQL 迁移、两份真实 Caddy 模板、静态资源与 API 重启持久化。
// 不运行模型或浏览器，也不验证 TLS 证书、跨主机 HA、systemd 权限及生产负载。
test(
  '编译产物通过部署入口提供 API 并在重启后保留任务',
  { timeout: 240_000 },
  async (t) => {
    const id = `proofrun-deploy-${randomUUID().slice(0, 8)}`;
    const network = `${id}-net`,
      postgres = `${id}-pg`,
      api = `${id}-api`,
      proxy = `${id}-proxy`;
    const directory = await mkdtemp(join(tmpdir(), 'proofrun-deploy-'));
    const admin = randomUUID(),
      worker = randomUUID(),
      password = randomUUID();
    // 清理仅针对本次创建的随机资源，不读取或修改现有预览服务。
    t.after(async () => {
      try {
        const ids = (
          await docker(
            'ps',
            '-aq',
            '--filter',
            `label=proofrun.deploy-test=${id}`,
          )
        )
          .split('\n')
          .filter(Boolean);
        if (ids.length) await docker('rm', '-f', ...ids);
      } finally {
        await docker('network', 'rm', network).catch(() => {});
        await rm(directory, { recursive: true, force: true });
      }
    });
    await readFile(join(ROOT, 'apps/api/dist/main.js'));
    await readFile(join(ROOT, 'apps/console/dist/index.html'));
    const nodeVersion = (
      await readFile(join(ROOT, '.node-version'), 'utf8')
    ).trim();
    await docker('network', 'create', network);
    await docker(
      'run',
      '-d',
      '--name',
      postgres,
      '--label',
      `proofrun.deploy-test=${id}`,
      '--network',
      network,
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      '-e',
      'POSTGRES_DB=proofrun',
      'postgres:17',
    );
    // 正式服务通过 TCP 连接数据库，不能把初始化阶段的临时 Unix socket 当成已就绪。
    await untilReady(async () => {
      await docker(
        'exec',
        postgres,
        'pg_isready',
        '-h',
        '127.0.0.1',
        '-U',
        'postgres',
        '-d',
        'proofrun',
      );
      return true;
    });
    await docker(
      'run',
      '-d',
      '--name',
      api,
      '--label',
      `proofrun.deploy-test=${id}`,
      '--network',
      network,
      '-p',
      '127.0.0.1::8080',
      '-v',
      `${ROOT}:/opt/proofrun:ro`,
      '-v',
      `${directory}:/data`,
      '-w',
      '/opt/proofrun',
      '-e',
      `PROOFRUN_DATABASE_URL=postgresql://postgres:${password}@${postgres}:5432/proofrun`,
      '-e',
      `PROOFRUN_ADMIN_TOKEN=${admin}`,
      '-e',
      `PROOFRUN_WORKER_TOKEN=${worker}`,
      '-e',
      'PROOFRUN_API_HOST=0.0.0.0',
      '-e',
      'PROOFRUN_ARTIFACT_DIRECTORY=/data/artifacts',
      `node:${nodeVersion}-bookworm-slim`,
      'node',
      'apps/api/dist/main.js',
    );
    /** 每次代理启动都读取原始模板；单实例和 HA 模板仅覆盖域名与上游环境变量。 */
    const startProxy = async (template) => {
      await docker(
        'run',
        '-d',
        '--name',
        proxy,
        '--label',
        `proofrun.deploy-test=${id}`,
        '--network',
        `container:${api}`,
        '-v',
        `${ROOT}:/opt/proofrun:ro`,
        '-e',
        'PROOFRUN_DOMAIN=http://:8080',
        '-e',
        'PROOFRUN_API_A=127.0.0.1:4100',
        '-e',
        'PROOFRUN_API_B=127.0.0.1:4100',
        CADDY_IMAGE,
        'caddy',
        'run',
        '--config',
        `/opt/proofrun/deploy/${template}`,
        '--adapter',
        'caddyfile',
      );
      const published = await docker('port', api, '8080/tcp');
      const base = `http://${published}`;
      await untilReady(async () => {
        const response = await fetch(`${base}/health/ready`, {
          signal: AbortSignal.timeout(2000),
        });
        const data = await response.json();
        return response.ok && data.status === 'ready';
      });
      return base;
    };
    const definition = JSON.parse(
      await readFile(
        join(ROOT, 'tests/scenarios/basic-form/task.json'),
        'utf8',
      ),
    );
    definition.taskId = randomUUID();
    definition.environment.nodePool = id;
    definition.budget.timeoutMs = 120_000;
    let submitted = false;
    for (const template of ['Caddyfile', 'Caddyfile.ha']) {
      const base = await startProxy(template);
      const index = await fetch(base);
      assert.equal(index.status, 200);
      assert.match(index.headers.get('content-type'), /text\/html/);
      const html = await index.text();
      const asset = html.match(/src="(\/assets\/[^"\s]+\.js)"/);
      assert.ok(asset, 'Console 页面应引用编译后的 JavaScript');
      const script = await fetch(base + asset[1]);
      assert.equal(script.status, 200);
      assert.match(script.headers.get('content-type'), /javascript/);
      await script.arrayBuffer();
      assert.equal(await (await fetch(`${base}/tasks/fixture`)).text(), html);
      for (const path of ['/v1/tasks', '/v2/cases/nonexistent']) {
        const rejected = await fetch(base + path);
        assert.equal(
          rejected.status,
          401,
          `${template} ${path} 必须进入 API 鉴权`,
        );
        assert.match(rejected.headers.get('content-type'), /application\/json/);
        await rejected.json();
      }
      if (!submitted) {
        const result = await fetch(`${base}/v1/tasks`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${admin}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(definition),
        });
        assert.equal(result.status, 202);
        await result.json();
        submitted = true;
      }
      const restored = await fetch(`${base}/v1/tasks/${definition.taskId}`, {
        headers: { authorization: `Bearer ${admin}` },
      });
      assert.equal(restored.status, 200);
      assert.deepEqual((await restored.json()).definition, definition);
      // 正常停止必须返回 0；先关闭代理，避免共享网络命名空间指向重启前的容器实例。
      await docker('rm', '-f', proxy);
      await docker('stop', '-t', '10', api);
      assert.equal(
        await docker('inspect', '--format', '{{.State.ExitCode}}', api),
        '0',
      );
      if (template === 'Caddyfile') await docker('start', api);
    }
    // 对照源码中的迁移文件，验证空库实际执行了全部迁移，而不只检查 HTTP 存活。
    const migrations = (
      await readdir(join(ROOT, 'apps/api/migrations'))
    ).filter((name) => name.endsWith('.sql'));
    const count = await docker(
      'exec',
      postgres,
      'psql',
      '-U',
      'postgres',
      '-d',
      'proofrun',
      '-Atc',
      'SELECT count(*) FROM pr_migrations',
    );
    assert.equal(Number(count), migrations.length);
  },
);
