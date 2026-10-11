import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Database } from '../src/db.js';
import { allocateIdentity } from '../src/modules/identities/allocation.js';
import { task } from './fixture.js';
import type { VerificationTask } from '@proofrun/contracts';

// 范围：真实 PostgreSQL 并发分配、账号别名互斥、终态但未关闭的保留；浏览器及登录为夹具。
test('底层测试账号在并发领取与未确认关闭期间保持独占', async () => {
  assert.ok(process.env.PROOFRUN_TEST_DATABASE_URL, '需要独立测试数据库');
  const admin = new pg.Pool({
    connectionString: process.env.PROOFRUN_TEST_DATABASE_URL,
  });
  const name = `identity_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.PROOFRUN_TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const db = new Database(url.toString());
  try {
    await db.start();
    const definitions = ['one', 'two', 'three'].map(
      (id, index) =>
        ({
          ...(task(id) as VerificationTask),
          sessionPlan: {
            version: 1,
            mode: 'identity',
            preparationMs: 120000,
            requirements: [],
            candidates: [
              {
                id: `alias-${index}`,
                label: '同一测试账号',
                accountKey: 'physical',
                origins: ['https://example.test'],
                checks: [],
                maxConcurrent: 1,
              },
            ],
          },
        }) as VerificationTask,
    );
    for (const t of definitions)
      await db.query(
        "INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at) VALUES($1,$2,'fixture','QUEUED',clock_timestamp()+interval '1 hour')",
        [t.taskId, JSON.stringify(t)],
      );
    const acquire = (t: VerificationTask) =>
      db.transaction(async (client) => {
        const allocated = await allocateIdentity(client, t);
        if (allocated)
          await client.query(
            "UPDATE pr_tasks SET state='RUNNING' WHERE id=$1",
            [t.taskId],
          );
        return allocated;
      });
    const results = await Promise.all(definitions.slice(0, 2).map(acquire));
    assert.equal(results.filter(Boolean).length, 1);
    const winner = results.find(Boolean)!;
    await db.query(
      "INSERT INTO pr_nodes(id,name,pool,credential_hash) VALUES('node','fixture','fixture','fixture')",
    );
    await db.query(
      "INSERT INTO pr_executions(id,task_id,worker_id,token_hash,lease_expires_at,state) VALUES('execution',$1,'worker','token',clock_timestamp()+interval '1 hour','FINISHED')",
      [winner.taskId],
    );
    await db.query(
      "INSERT INTO pr_sessions(id,execution_id,node_id,node_epoch,lease_id,fence,state,closure_verified) VALUES('session','execution','node','epoch','lease',1,'QUARANTINED',false)",
    );
    await db.query("UPDATE pr_tasks SET state='COMPLETED' WHERE id=$1", [
      winner.taskId,
    ]);
    assert.equal(await acquire(definitions[2]!), null);
    await db.query(
      "UPDATE pr_sessions SET state='CLOSED',closure_verified=true WHERE id='session'",
    );
    assert.ok(await acquire(definitions[2]!));
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
