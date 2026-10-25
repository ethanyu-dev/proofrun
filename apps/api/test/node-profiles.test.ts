import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { SimulatedNode, task, until } from './fixture.js';

/** 凭据仅用于回环协议夹具，不连接真实节点或外部网站。 */
const ADMIN = 'node-profile-console-admin-fixture-token'.padEnd(500, 'x');
const WORKER = 'node-profile-worker-fixture-token';
// 范围：真实 HTTP、数据库的鉴权与退役拒绝；节点为协议夹具，不证明 Chrome 登录。
test('Console 节点模板退役后不再创建会话', { timeout: 45_000 }, async () => {
  assert.ok(process.env.PROOFRUN_TEST_DATABASE_URL);
  const admin = new pg.Pool({
    connectionString: process.env.PROOFRUN_TEST_DATABASE_URL,
  });
  const name = `node_profiles_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.PROOFRUN_TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const sql = new pg.Pool({ connectionString: url.toString() });
  const root = await mkdtemp(join(tmpdir(), 'proofrun-node-profiles-'));
  const config: ApiConfig = {
    databaseUrl: url.toString(),
    adminToken: ADMIN,
    workerToken: WORKER,
    publicUrl: 'http://127.0.0.1',
    artifactDirectory: root,
    host: '127.0.0.1',
    port: 0,
    workerLeaseMs: 10_000,
    nodeLeaseMs: 10_000,
    tickMs: 30,
  };
  const app = await buildApp(config, { logger: false });
  const base = await app.listen({ port: 0, host: '127.0.0.1' });
  config.publicUrl = base;
  const node = new SimulatedNode(base, 'profile', 1);
  const request = async (path: string, body?: unknown, token = ADMIN) =>
    fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const api = async (path: string, body?: unknown) => {
    const response = await request(path, body);
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify({ path, data }));
    return data;
  };
  const path = `/v1/nodes/${node.id}/profile`;
  try {
    await node.pair(ADMIN);
    await until(
      () => api('/v1/nodes'),
      (data) => data.nodes.some((n: any) => n.online),
    );
    // 范围：退役入口仍需鉴权，拒绝写入不分配浏览器；不验证历史物理会话的关闭。
    assert.equal(
      (await request(path, { url: 'https://example.test' }, WORKER)).status,
      401,
    );
    const retired = await request(path, { url: 'https://example.test' });
    assert.equal(retired.status, 410);
    assert.equal((await retired.json()).code, 'NODE_PROFILE_RETIRED');
    assert.equal((await request(path)).status, 410);
    assert.equal(
      (await sql.query('SELECT count(*)::int n FROM pr_tasks')).rows[0].n,
      0,
    );
    assert.equal(
      (await sql.query('SELECT count(*)::int n FROM pr_commands')).rows[0].n,
      0,
    );
    // 范围：历史 ID 读取与关闭进入通用取消链路；关闭由模拟节点确认，不证明真实进程退出。
    const definition = task('profile');
    await api('/v1/tasks', definition);
    const claimed = await request(
      '/v1/worker/claim',
      { type: 'worker.claim', workerId: randomUUID() },
      WORKER,
    );
    const { execution } = await claimed.json();
    assert.ok(execution);
    await until(
      async () =>
        (
          await request(
            `/v1/executions/${execution.id}`,
            undefined,
            execution.leaseToken,
          )
        ).json(),
      (data) => data.state === 'RUNNING',
    );
    const id = randomUUID();
    await sql.query(
      `INSERT INTO pr_interventions(id,execution_id,revision,token_hash,items,expires_at)
        VALUES($1,$2,0,'fixture','[]',clock_timestamp()+interval '1 minute')`,
      [id, execution.id],
    );
    await sql.query(
      'INSERT INTO pr_node_profiles(id,task_id,node_id) VALUES($1,$2,$3)',
      [id, definition.taskId, node.id],
    );
    const history = await api(`/v1/node-profiles/${id}`);
    assert.equal(history.taskId, definition.taskId);
    assert.equal(history.closed, false);
    assert.equal(
      (await request(`/v1/node-profiles/${id}/close`, {}, WORKER)).status,
      401,
    );
    await api(`/v1/node-profiles/${id}/close`, {});
    await until(
      () => api(`/v1/node-profiles/${id}`),
      (data) => data.closed === true,
    );
    assert.equal(
      (await api(`/v1/tasks/${definition.taskId}`)).state,
      'CANCELLED',
    );
    await api(`/v1/node-profiles/${id}/close`, {});
    assert.equal(
      (await request(`/v1/node-profiles/${randomUUID()}`)).status,
      404,
    );
    // 范围：旧资源锁输入明确拒绝，不让调用者误以为仍有互斥；不验证跨任务业务依赖。
    const locked = await request('/v1/tasks', {
      ...task('profile'),
      resourceKey: 'legacy-lock',
    });
    assert.equal(locked.status, 422);
    assert.equal((await locked.json()).code, 'RESOURCE_LOCK_RETIRED');
  } finally {
    node.close();
    await app.close();
    await sql.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  }
});
