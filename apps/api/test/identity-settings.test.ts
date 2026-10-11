import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, readdir, stat, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { until } from './fixture.js';

/** 只供独立库和回环提供方使用的假凭据，不对应任何真实账号。 */
const ADMIN = 'fixture-identity-settings-admin-token';
const WORKER = 'fixture-identity-settings-worker-token';
const SECRET = 'fixture-private-provider-token';
const CATALOG = {
  identities: [
    {
      id: 'member',
      label: '测试成员',
      accountKey: 'physical-member',
      origins: ['https://example.test'],
      maxConcurrent: 1,
      loginRef: 'member-login',
      checks: [
        {
          id: 'account',
          method: 'text',
          description: '确认测试成员',
          value: 'fixture-member',
        },
      ],
    },
  ],
  pools: [{ id: 'members', identityRefs: ['member'] }],
  sites: [
    {
      id: 'site',
      hostname: 'example.test',
      environment: 'fixture',
      nodePool: 'fixture',
      poolRef: 'members',
    },
  ],
};

// 范围：真实 PostgreSQL、管理路由、私有文件与回环提供方；不登录真实站点，也不证明节点凭据已配置。
test('页面身份配置鉴权、热生效、版本冲突、连接验证及重启持久化', async () => {
  assert.ok(process.env.PROOFRUN_TEST_DATABASE_URL, '需要独立测试数据库');
  const adminDb = new pg.Pool({
    connectionString: process.env.PROOFRUN_TEST_DATABASE_URL,
  });
  const name = `settings_${randomUUID().replaceAll('-', '')}`;
  await adminDb.query(`CREATE DATABASE ${name}`);
  const dbUrl = new URL(process.env.PROOFRUN_TEST_DATABASE_URL);
  dbUrl.pathname = `/${name}`;
  // 单连接的 end 会等待 socket 关闭，避免辅助查询连接尚未断开就进入删库。
  const queryDb = new pg.Client({ connectionString: dbUrl.toString() });
  await queryDb.connect();
  const directory = await mkdtemp(join(tmpdir(), 'identity-settings-'));
  let providerBad = false;
  let calls = 0;
  const provider = createServer((request, response) => {
    calls++;
    assert.equal(request.headers.authorization, `Bearer ${SECRET}`);
    response.setHeader('Content-Type', 'application/json');
    if (providerBad) response.writeHead(503).end('sensitive-provider-error');
    else response.end(JSON.stringify(CATALOG));
  });
  await new Promise<void>((resolve) =>
    provider.listen(0, '127.0.0.1', resolve),
  );
  const endpoint = `http://127.0.0.1:${(provider.address() as { port: number }).port}/catalog`;
  const config: ApiConfig = {
    databaseUrl: dbUrl.toString(),
    adminToken: ADMIN,
    workerToken: WORKER,
    publicUrl: 'http://127.0.0.1:4168',
    artifactDirectory: directory,
    host: '127.0.0.1',
    port: 0,
    workerLeaseMs: 15000,
    nodeLeaseMs: 20000,
    tickMs: 5000,
    caseProfile: {
      environment: { id: 'fixture', nodePool: 'fixture' },
      budget: { maxActions: 30 },
      evidenceKinds: ['DOM'],
      executionMode: 'llm',
    },
  };
  let app = await buildApp(config, { logger: false });
  const get = (path: string) =>
    app.inject({
      method: 'GET',
      url: path,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
  const post = (path: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: path,
      headers: {
        authorization: `Bearer ${ADMIN}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify(payload),
    });
  const settingsPath = '/v1/admin/identities/settings';
  try {
    // 范围：管理员边界和读取不缓存；不验证外层反向代理。
    for (const path of [
      settingsPath,
      '/v1/admin/identities',
      '/v1/admin/identities/metrics',
    ]) {
      assert.equal((await app.inject(path)).statusCode, 401);
      const response = await get(path);
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: settingsPath,
          payload: { revision: 0, mode: 'environment' },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/identities/test',
          headers: { authorization: `Bearer ${WORKER}` },
          payload: { revision: 0, mode: 'environment' },
        })
      ).statusCode,
      401,
    );
    assert.equal((await get(settingsPath)).json().revision, 0);

    const invalid = await post(settingsPath, {
      revision: 0,
      mode: 'local',
      catalog: { ...CATALOG, password: SECRET },
    });
    assert.equal(invalid.statusCode, 400);
    assert.ok(!invalid.body.includes(SECRET));
    const dangling = await post(settingsPath, {
      revision: 0,
      mode: 'local',
      catalog: {
        ...CATALOG,
        pools: [{ id: 'members', identityRefs: ['missing'] }],
      },
    });
    assert.equal(dangling.statusCode, 400);
    const local = { revision: 0, mode: 'local', catalog: CATALOG };
    assert.equal(
      (await post('/v1/admin/identities/test', local)).statusCode,
      200,
    );
    assert.equal((await get(settingsPath)).json().revision, 0);
    assert.equal((await post(settingsPath, local)).json().revision, 1);
    assert.equal((await post(settingsPath, local)).statusCode, 409);

    // 范围：保存后的新 case 按站点规则冻结身份，已有 case 不跟随改名；任务只排队，不运行浏览器。
    const submit = (caseId: string) =>
      post('/v2/cases', [
        {
          caseId,
          platform: '夹具',
          entry: 'https://example.test/',
          session: { mode: 'auto' },
          steps: [
            {
              type: 'verification',
              exec_order: 1,
              url: 'https://example.test/',
              description: '检查夹具',
              expected: ['显示夹具'],
              policy: [],
            },
          ],
          cleanup: [],
        },
      ]);
    const submitted = await submit('before');
    assert.equal(submitted.statusCode, 202, submitted.body);
    const frozen = async (id: string) =>
      (
        await queryDb.query('SELECT definition FROM pr_tasks WHERE id=$1', [
          `case-v2-${id}`,
        ])
      ).rows[0].definition.sessionPlan.candidates[0].label;
    assert.equal(await frozen('before'), '测试成员');
    const changed = structuredClone(CATALOG);
    changed.identities[0]!.label = '更新后的成员';
    assert.equal(
      (
        await post(settingsPath, {
          revision: 1,
          mode: 'local',
          catalog: changed,
        })
      ).statusCode,
      200,
    );
    assert.equal((await submit('after')).statusCode, 202);
    assert.equal(await frozen('after'), '更新后的成员');
    assert.equal(await frozen('before'), '测试成员');

    const external = {
      revision: 2,
      mode: 'http',
      url: endpoint,
      token: SECRET,
    };
    const tested = await post('/v1/admin/identities/test', external);
    assert.equal(tested.statusCode, 200, tested.body);
    assert.equal(calls, 1);
    assert.equal((await get(settingsPath)).json().mode, 'local');
    assert.ok(!(await readdir(directory)).includes('.identity-secrets'));
    const saved = await post(settingsPath, external);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().revision, 3);
    assert.equal(saved.json().tokenConfigured, true);
    assert.ok(!saved.body.includes(SECRET));
    assert.ok(!saved.body.includes(directory));
    const rows = await queryDb.query('SELECT * FROM pr_identity_settings');
    assert.ok(!JSON.stringify(rows.rows).includes(SECRET));
    const tokenDir = join(directory, '.identity-secrets');
    const files = await readdir(tokenDir);
    assert.equal(files.length, 1);
    assert.equal((await stat(tokenDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(tokenDir, files[0]!))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(tokenDir, files[0]!), 'utf8'), SECRET);
    assert.equal(
      (await get('/v1/admin/identities')).json().catalog.identities.length,
      1,
    );
    // 范围：地址替换必须重填令牌，不把既存秘密转发到其他 URL。
    const countBefore = calls;
    assert.equal(
      (
        await post('/v1/admin/identities/test', {
          revision: 3,
          mode: 'http',
          url: endpoint + '-other',
        })
      ).json().code,
      'IDENTITY_TOKEN_REQUIRED',
    );
    assert.equal(calls, countBefore);
    assert.equal(
      (await post(settingsPath, { revision: 3, mode: 'http', url: endpoint }))
        .statusCode,
      200,
    );
    assert.deepEqual(await readdir(tokenDir), files);

    providerBad = true;
    const failed = await post(settingsPath, {
      revision: 4,
      mode: 'http',
      url: endpoint,
      token: SECRET,
    });
    assert.equal(failed.statusCode, 503);
    assert.ok(!failed.body.includes('sensitive-provider-error'));
    assert.equal((await get(settingsPath)).json().revision, 4);
    assert.equal((await get(settingsPath)).statusCode, 200);
    assert.equal(
      (await post('/v1/admin/identities/refresh', {})).statusCode,
      503,
    );
    assert.equal((await get('/v1/admin/identities')).statusCode, 503);
    providerBad = false;
    await app.close();
    app = await buildApp(config, { logger: false });
    assert.equal((await get(settingsPath)).json().revision, 4);
    assert.equal(
      (await get('/v1/admin/identities')).json().catalog.identities.length,
      1,
    );
    // 范围：不安全目录拒绝保存，并发令牌轮换只保留获胜版本的文件；不模拟磁盘断电。
    await chmod(tokenDir, 0o755);
    assert.equal(
      (
        await post(settingsPath, {
          revision: 4,
          mode: 'http',
          url: endpoint,
          token: SECRET,
        })
      ).json().code,
      'IDENTITY_SECRET_STORAGE',
    );
    assert.equal((await get(settingsPath)).json().revision, 4);
    await chmod(tokenDir, 0o700);
    const rotations = await Promise.all([
      post(settingsPath, {
        revision: 4,
        mode: 'http',
        url: endpoint,
        token: SECRET,
      }),
      post(settingsPath, {
        revision: 4,
        mode: 'http',
        url: endpoint,
        token: SECRET,
      }),
    ]);
    assert.deepEqual(rotations.map((r) => r.statusCode).sort(), [200, 409]);
    const rotated = await readdir(tokenDir);
    assert.equal(rotated.length, 1);
    assert.notDeepEqual(rotated, files);
    assert.ok(rotations.every((r) => !r.body.includes(SECRET)));
    const concurrent = await Promise.all([
      post(settingsPath, { revision: 5, mode: 'local', catalog: CATALOG }),
      post(settingsPath, { revision: 5, mode: 'environment' }),
    ]);
    assert.deepEqual(concurrent.map((r) => r.statusCode).sort(), [200, 409]);
    assert.equal((await get(settingsPath)).json().revision, 6);
    assert.deepEqual(await readdir(tokenDir), []);
    assert.equal(
      (await post(settingsPath, { revision: 6, mode: 'environment' }))
        .statusCode,
      200,
    );
    assert.deepEqual(
      (await get('/v1/admin/identities')).json().catalog.identities,
      [],
    );
  } finally {
    await app.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await queryDb.end();
    // Pool.end 返回不代表服务端已处理全部断连；等待归零，且不强制删库掩盖连接泄漏。
    await until(
      async () =>
        Number(
          (
            await adminDb.query(
              'SELECT count(*) AS count FROM pg_stat_activity WHERE datname=$1',
              [name],
            )
          ).rows[0].count,
        ),
      (count) => count === 0,
    );
    await adminDb.query(`DROP DATABASE ${name}`);
    await adminDb.end();
    await rm(directory, { recursive: true, force: true });
  }
});
