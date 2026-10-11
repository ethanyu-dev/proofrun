import {
  identitySummary,
  identityMetrics,
} from '../src/modules/identities/metrics.js';
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
    // 范围：池中首个账号忙时选下一个；未落实到节点的选择不冻结账号，仍不启动真实浏览器。
    const poolTask = structuredClone(definitions[2]!);
    poolTask.taskId = 'pool';
    poolTask.sessionPlan!.mode = 'pool';
    const alternative = {
      ...poolTask.sessionPlan!.candidates[0]!,
      id: 'free',
      accountKey: 'free',
    };
    poolTask.sessionPlan!.candidates.push(alternative);
    await db.query(
      "INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at) VALUES($1,$2,'fixture','QUEUED',clock_timestamp()+interval '1 hour')",
      [poolTask.taskId, JSON.stringify(poolTask)],
    );
    const selected = await db.transaction((c) =>
      allocateIdentity(c, poolTask, undefined, { reserve: false }),
    );
    assert.equal(selected!.sessionPlan!.candidates[0]!.id, 'free');
    assert.equal(
      (
        await db.query(
          'SELECT 1 FROM pr_identity_assignments WHERE task_id=$1',
          ['pool'],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      await db.transaction((c) =>
        allocateIdentity(c, poolTask, undefined, { eligible: () => false }),
      ),
      null,
    );
    // 范围：同轮对照不能因池中其他账号空闲而更换身份；第一组清理后第二组使用相同账号。
    const first = structuredClone(poolTask);
    first.taskId = 'pair-first';
    first.comparison = { id: 'pair', arm: 'llm', sourceTaskId: 'pair-source' };
    const second = {
      ...structuredClone(first),
      taskId: 'pair-second',
      comparison: { ...first.comparison, arm: 'jev' as const },
    };
    for (const item of [first, second])
      await db.query(
        "INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at) VALUES($1,$2,'fixture','QUEUED',clock_timestamp()+interval '1 hour')",
        [item.taskId, JSON.stringify(item)],
      );
    const firstChoice = await acquire(first);
    assert.equal(firstChoice!.sessionPlan!.candidates[0]!.id, 'free');
    // 再加一个可用身份，第二组仍须等待第一组账号。
    second.sessionPlan!.candidates.push({
      ...alternative,
      id: 'another',
      accountKey: 'another',
    });
    assert.equal(await acquire(second), null);
    await db.query(
      "UPDATE pr_tasks SET state='COMPLETED' WHERE id='pair-first'",
    );
    const secondChoice = await acquire(second);
    assert.equal(secondChoice!.sessionPlan!.candidates[0]!.id, 'free');
    await db.query(
      "UPDATE pr_tasks SET state='COMPLETED' WHERE id='pair-second'",
    );
    // 范围：统计使用持久命令回执、人工分类及物理释放状态；登录回执为夹具，不代表真实登录成功率。
    await db.query(
      "INSERT INTO pr_commands(id,execution_id,session_id,node_id,kind,request_hash,envelope,deadline_at,created_at,completed_at,result) VALUES('prep','execution','session','node','browser.identity.prepare','fixture','{}',clock_timestamp(),clock_timestamp()-interval '1 second',clock_timestamp(),$1)",
      [
        JSON.stringify({
          operationStatus: 'SUCCEEDED',
          data: {
            status: 'READY',
            source: 'cookies',
            reasonCode: 'IDENTITY_VERIFIED',
          },
        }),
      ],
    );
    await db.query(
      "INSERT INTO pr_interventions(id,execution_id,revision,token_hash,items,expires_at,completed_at,reason_code) VALUES('human','execution',1,'fixture','[]',clock_timestamp(),clock_timestamp(),'IDENTITY_CHECK_UNMET')",
    );
    const summary = await identitySummary(
      db,
      winner.taskId,
      winner.sessionPlan!,
    );
    assert.equal(summary.identityRef, winner.sessionPlan!.candidates[0]!.id);
    assert.equal(summary.leaseState, 'RELEASED');
    assert.equal(summary.preparation.source, 'cookies');
    assert.equal(summary.humanCompleted, 1);
    assert.equal(summary.humanRequests, 1);
    const metrics = await identityMetrics(db);
    assert.equal(metrics.completedPreparations, 1);
    assert.equal(metrics.automaticReadyRate, 1);
    assert.equal(metrics.hitl[0]!.reason, 'IDENTITY_CHECK_UNMET');
    assert.equal(metrics.accounts[0]!.occupied, 1);
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
