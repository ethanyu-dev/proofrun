import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HaApi } from '../src/ha.js';
import { task, until, SimulatedNode } from './fixture.js';

/** 测试角色仅用于隔离数据库，不访问用户的任务或机器凭据。 */
const ADMIN = 'proofrun-ha-fixture-admin-credential';
const WORKER = 'proofrun-ha-fixture-worker-credential';

// 范围：两个真实 HTTP/WS API 入口竞争同一 PostgreSQL 锁、节点接入、锁连接中断和主备交接；不证明数据库自身高可用或真实浏览器不中断。
test(
  'API 主备只允许一个活动控制面并保留故障前任务',
  { timeout: 30_000 },
  async () => {
    const connectionString = process.env.PROOFRUN_TEST_DATABASE_URL;
    assert.ok(connectionString, '配置独立测试数据库');
    const admin = new pg.Pool({ connectionString });
    const name = `proofrun_ha_${randomUUID().replaceAll('-', '')}`;
    const directory = await mkdtemp(join(tmpdir(), 'proofrun-ha-'));
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(connectionString);
    url.pathname = `/${name}`;
    const sql = new pg.Pool({ connectionString: url.toString() });
    const config = {
      databaseUrl: url.toString(),
      adminToken: ADMIN,
      workerToken: WORKER,
      publicUrl: 'http://127.0.0.1',
      artifactDirectory: directory,
      host: '127.0.0.1',
      port: 0,
      workerLeaseMs: 4000,
      nodeLeaseMs: 4000,
      tickMs: 50,
    };
    const replicas = [new HaApi(config), new HaApi(config)];
    const nodes: SimulatedNode[] = [];
    try {
      await Promise.all(replicas.map((api) => api.listen()));
      const bases = replicas.map(
        (api) =>
          `http://127.0.0.1:${(api.server.address() as { port: number }).port}`,
      );
      const ready = () =>
        Promise.all(
          bases.map((base) =>
            fetch(`${base}/health/ready`)
              .then((r) => r.status)
              .catch(() => 0),
          ),
        );
      const states = await until(
        ready,
        (states) => states.filter((s) => s === 200).length === 1,
      );
      const active = states.indexOf(200),
        standby = 1 - active;
      assert.equal(states[standby], 503);
      const definition = task('ha-fixture');
      const submitted = await fetch(`${bases[active]}/v1/tasks`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${ADMIN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(definition),
      });
      assert.equal(submitted.status, 202);
      const node = new SimulatedNode(bases[active]!, 'ha-fixture');
      nodes.push(node);
      await node.pair(ADMIN);
      assert.equal(
        (
          await fetch(`${bases[active]}/v1/nodes`, {
            headers: { authorization: `Bearer ${ADMIN}` },
          })
        ).status,
        200,
      );
      // 真正断开持锁数据库连接，观察旧实例撤销就绪；未杀死 PostgreSQL 其它连接。
      const owners = await sql.query(
        "SELECT pid FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND granted",
      );
      assert.equal(owners.rows.length, 1);
      await sql.query('SELECT pg_terminate_backend($1)', [owners.rows[0].pid]);
      await until(ready, (states) => states[active] !== 200);
      await replicas[active]!.close();
      await until(ready, (states) => states[standby] === 200);
      const restored = await fetch(
        `${bases[standby]}/v1/tasks/${definition.taskId}`,
        { headers: { authorization: `Bearer ${ADMIN}` } },
      );
      assert.equal(restored.status, 200);
      assert.deepEqual((await restored.json()).definition, definition);
      assert.equal(
        (
          await fetch(`${bases[standby]}/v1/tasks/${definition.taskId}`, {
            headers: { authorization: 'Bearer wrong' },
          })
        ).status,
        401,
      );
    } finally {
      for (const node of nodes) node.close();
      await Promise.all(replicas.map((api) => api.close()));
      await sql.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
