import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { Database } from '../src/db.js';

/** 以正式历史迁移构造升级前数据库，避免仅用空表代替已有节点的迁移验证。 */
const MIGRATIONS = new URL('../migrations/', import.meta.url);
/** 固定退役字段的迁移边界；后续迁移也必须保持节点数据可读。 */
const CAPACITY_REMOVAL_VERSION = 36;

// 范围：真实 PostgreSQL 从旧库升级并重启，保留节点准入和占用事实；不运行真实节点或模拟生产备份恢复。
test('升级删除节点 capacity 且保留资源准入事实', async () => {
  const databaseUrl = process.env.PROOFRUN_TEST_DATABASE_URL;
  assert.ok(databaseUrl, '请设置独立测试 PostgreSQL 地址');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const name = `node_capacity_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  let db = new Database(url.toString());
  try {
    await db.query(
      'CREATE TABLE pr_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())',
    );
    for (const file of (await readdir(MIGRATIONS)).sort()) {
      const version = Number(file.slice(0, 3));
      if (!file.endsWith('.sql') || version >= CAPACITY_REMOVAL_VERSION)
        continue;
      await db.transaction(async (client) => {
        await client.query(await readFile(new URL(file, MIGRATIONS), 'utf8'));
        await client.query('INSERT INTO pr_migrations(version) VALUES($1)', [
          version,
        ]);
      });
    }
    const admission = { accepting: true, reason: 'AVAILABLE', cpuPercent: 10 };
    const inventory = [{ sessionId: 'historical-session', state: 'ACTIVE' }];
    await db.query(
      `INSERT INTO pr_nodes(id,name,pool,credential_hash,capacity,admission,inventory)
       VALUES('node-1','历史节点','internal','fixture-hash',1,$1,$2)`,
      [admission, JSON.stringify(inventory)],
    );
    await db.start();
    const row = (await db.query("SELECT * FROM pr_nodes WHERE id='node-1'"))
      .rows[0];
    assert.ok(row);
    assert.equal(Object.hasOwn(row, 'capacity'), false);
    assert.equal(row.name, '历史节点');
    assert.equal(row.credential_hash, 'fixture-hash');
    assert.deepEqual(row.admission, admission);
    assert.deepEqual(row.inventory, inventory);
    await db.close();
    db = new Database(url.toString());
    await db.start();
    assert.equal((await db.query('SELECT * FROM pr_nodes')).rows.length, 1);
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
