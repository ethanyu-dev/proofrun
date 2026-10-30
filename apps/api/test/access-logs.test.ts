import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { AccessLogPage } from '@proofrun/contracts';
import { buildApp } from '../src/app.js';
import { parseTrustedProxies } from '../src/config.js';
import { until } from './fixture.js';

/** 测试凭据和模拟 IP 仅用于隔离库；不连接实际部署服务。 */
const ADMIN = 'access-log-test-admin-fixture';
const DATABASE_URL = process.env.PROOFRUN_TEST_DATABASE_URL;

// 范围：受信代理配置语法和默认关闭；不验证真实部署的网络隔离。
test('代理配置只接受明确地址及网段', () => {
  assert.equal(parseTrustedProxies(''), undefined);
  assert.deepEqual(parseTrustedProxies('127.0.0.1, ::1, 10.10.0.0/16'), [
    '127.0.0.1',
    '::1',
    '10.10.0.0/16',
  ]);
  for (const invalid of [
    'true',
    '1',
    'localhost',
    '0.0.0.0/0',
    '::/0',
    '10.0.0.0/33',
    '::1/129',
    '127.0.0.1,',
    '127.0.0.1//32',
    'fe80::1%lo0',
  ])
    assert.throws(
      () => parseTrustedProxies(invalid),
      /PROOFRUN_TRUSTED_PROXIES/,
      invalid,
    );
});

// 范围：真实迁移、SQL、Fastify 生命周期、重启持久性及连接关闭；地址由注入夹具提供，不等同于实际反向代理验收。
test(
  '访问记录覆盖登录、错误请求、来源解析、分页和保留期',
  { timeout: 60_000 },
  async (t) => {
    assert.ok(
      DATABASE_URL,
      '请设置独立测试 PostgreSQL 的 PROOFRUN_TEST_DATABASE_URL',
    );
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    const name = `proofrun_access_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DATABASE_URL);
    url.pathname = `/${name}`;
    const directory = await mkdtemp(join(tmpdir(), 'proofrun-access-'));
    // 单连接的 end 等待 socket 关闭，避免 Pool.end 返回后删库与断连竞争。
    const sql = new pg.Client({ connectionString: url.toString() });
    await sql.connect();
    const config = {
      databaseUrl: url.toString(),
      adminToken: ADMIN,
      workerToken: 'access-test-worker',
      publicUrl: 'http://localhost',
      artifactDirectory: directory,
      host: '127.0.0.1',
      port: 0,
      workerLeaseMs: 15000,
      nodeLeaseMs: 20000,
      tickMs: 1000,
      trustedProxies: ['127.0.0.1', '::1'],
    };
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    t.after(async () => {
      await app?.close();
      await sql.end();
      // 服务连接池清空后，仍须等待 PostgreSQL 确认所有连接已退出；超时暴露泄漏，不强制踢连接。
      await until(
        async () =>
          Number(
            (
              await admin.query(
                'SELECT count(*) AS count FROM pg_stat_activity WHERE datname=$1',
                [name],
              )
            ).rows[0].count,
          ),
        (count) => count === 0,
      );
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    });
    app = await buildApp(config, { logger: false });
    const headers = { authorization: `Bearer ${ADMIN}` };
    const read = async (query = '') => {
      const result = await app!.inject({
        url: `/v1/admin/access-logs${query}`,
        headers,
      });
      assert.equal(result.statusCode, 200, result.body);
      return result.json<AccessLogPage>();
    };
    assert.equal(
      (await app.inject({ url: '/v1/admin/access-logs' })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/console-login',
          remoteAddress: '198.51.100.1',
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/console-login',
          headers,
          remoteAddress: '198.51.100.2',
        })
      ).statusCode,
      200,
    );
    await app.inject({
      url: '/v1/tasks/private-path?token=private-query',
      remoteAddress: '198.51.100.3',
      headers: { 'x-forwarded-for': '203.0.113.99' },
    });
    await app.inject({
      url: '/unknown/private-path?token=private-query',
      remoteAddress: '::ffff:198.51.100.4',
    });
    await app.inject({
      url: '/health/live',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.99, 198.51.100.5' },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/admin/console-login',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: '{invalid',
      remoteAddress: '2001:db8::1',
    });
    const all = await read();
    assert.equal(all.retentionDays, 30);
    assert.equal(
      all.records.find((r) => r.ip === '198.51.100.1')?.statusCode,
      401,
    );
    assert.equal(
      all.records.find((r) => r.ip === '198.51.100.2')?.statusCode,
      200,
    );
    assert.equal(
      all.records.find((r) => r.ip === '198.51.100.3')?.route,
      '/v1/tasks/:id',
    );
    assert.equal(
      all.records.find((r) => r.ip === '198.51.100.4')?.statusCode,
      404,
    );
    assert.ok(all.records.some((r) => r.ip === '198.51.100.5'));
    assert.ok(!all.records.some((r) => r.ip === '203.0.113.99'));
    assert.equal(
      all.records.find((r) => r.ip === '2001:db8::1')?.statusCode,
      400,
    );
    assert.ok(
      all.records.every(
        (r) => r.durationMs >= 0 && Number.isFinite(Date.parse(r.at)),
      ),
    );
    const persisted = JSON.stringify(
      (await sql.query('SELECT * FROM pr_access_logs')).rows,
    );
    for (const secret of ['private-path', 'private-query', ADMIN, 'invalid'])
      assert.ok(!persisted.includes(secret));
    assert.equal((await read('?kind=console_login')).records.length, 3);
    assert.ok(
      (await read('?kind=http')).records.every((r) => r.kind === 'http'),
    );
    assert.equal((await read('?ip=198.51.100.2')).records.length, 1);
    for (const query of [
      'kind=other',
      'ip=example.com',
      'ip=fe80::1%25lo0',
      'ip=127.0.0.1&ip=::1',
      'before=0',
      'before=9223372036854775808',
      'limit=999',
    ])
      assert.equal(
        (await app.inject({ url: `/v1/admin/access-logs?${query}`, headers }))
          .statusCode,
        400,
        query,
      );

    // 分页数据直接写入隔离库，验证并发新增不会让旧游标重复返回，不模拟生产访问量。
    await sql.query(`INSERT INTO pr_access_logs(at,ip,kind,method,route,status_code,duration_ms)
    SELECT clock_timestamp(), '203.0.113.10', 'http', 'GET', '/fixture', 200, 1 FROM generate_series(1,56)`);
    await sql.query(`INSERT INTO pr_access_logs(at,ip,kind,method,route,status_code,duration_ms)
    VALUES(clock_timestamp()-interval '31 days', '203.0.113.10', 'http', 'GET', '/expired', 200, 1)`);
    const first = await read('?ip=203.0.113.10');
    assert.equal(first.records.length, 50);
    assert.ok(first.nextCursor);
    await app.inject({ url: '/health/live', remoteAddress: '203.0.113.10' });
    const second = await read(`?ip=203.0.113.10&before=${first.nextCursor}`);
    assert.equal(second.records.length, 6);
    assert.equal(second.nextCursor, null);
    assert.equal(
      new Set([...first.records, ...second.records].map((r) => r.id)).size,
      56,
    );
    assert.ok(!first.records.some((r) => r.route === '/expired'));
    await app.close();
    app = await buildApp(
      { ...config, trustedProxies: undefined },
      { logger: false },
    );
    assert.equal(
      (await read('?ip=203.0.113.10')).records[1]?.id,
      first.records[0]?.id,
    );
    assert.equal(
      (await sql.query("SELECT 1 FROM pr_access_logs WHERE route='/expired'"))
        .rowCount,
      0,
    );
    await app.inject({
      url: '/health/live',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '192.0.2.100' },
    });
    assert.equal((await read('?ip=192.0.2.100')).records.length, 0);
  },
);
