import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { Database } from '../src/db.js';

/** 按正式迁移顺序构造退役前数据库，不以简化表结构替代升级路径。 */
const MIGRATIONS = new URL('../migrations/', import.meta.url);
/** 固定报告分析退役边界，后续迁移不得重新创建这些表。 */
const ANALYSIS_REMOVAL_VERSION = 37;
/** 同时核对主键与业务索引，确保没有留下旧分析存储对象。 */
const RETIRED_RELATIONS = [
  'pr_request_analyses',
  'pr_request_analyses_pkey',
  'pr_analysis_queue',
  'pr_analysis_calls',
  'pr_analysis_calls_pkey',
  'pr_analysis_calls_revision',
  'pr_analysis_calls_started',
];

/** 临时数据库分别覆盖已有数据升级与空库启动；重启后继续检查迁移只登记一次。 */
async function verifyMigration(historical: boolean) {
  const databaseUrl = process.env.PROOFRUN_TEST_DATABASE_URL;
  assert.ok(databaseUrl, '请设置独立测试 PostgreSQL 地址');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const name = `analysis_removal_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  let db = new Database(url.toString());
  try {
    if (historical) {
      await db.query(
        'CREATE TABLE pr_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())',
      );
      for (const file of (await readdir(MIGRATIONS)).sort()) {
        const version = Number(file.slice(0, 3));
        if (!file.endsWith('.sql') || version >= ANALYSIS_REMOVAL_VERSION)
          continue;
        await db.transaction(async (client) => {
          await client.query(await readFile(new URL(file, MIGRATIONS), 'utf8'));
          await client.query('INSERT INTO pr_migrations(version) VALUES($1)', [
            version,
          ]);
        });
      }
      // 覆盖排队、持有租约、成功和失败记录，删除不依赖分析终态或清理标记。
      for (const status of ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED']) {
        await db.query(
          "INSERT INTO pr_verification_requests(request_id,title,definition_hash) VALUES($1,'验证请求','fixture')",
          [status],
        );
        await db.query(
          `INSERT INTO pr_request_analyses(request_id,revision,status,snapshot,summary,token_hash,lease_until)
           VALUES($1,'fixture',$1,'{"cases":[]}','历史分析','fixture',clock_timestamp()+interval '1 minute')`,
          [status],
        );
        await db.query(
          `INSERT INTO pr_analysis_calls(request_id,call_id,revision,token_hash,model,stage,status,prompt_tokens,completion_tokens,start_hash)
           VALUES($1,'fixture','fixture','fixture','fixture','review','RECEIVED',100,10,'fixture')`,
          [status],
        );
      }
      // 验证执行和用量作为独立事实保留，不运行真实浏览器或模型。
      await db.query(
        `INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at,report)
         VALUES('fixture','{}','fixture','COMPLETED',clock_timestamp(),'{"summary":"原始报告"}')`,
      );
      await db.query(
        `INSERT INTO pr_executions(id,task_id,worker_id,token_hash,lease_expires_at,state)
         VALUES('fixture','fixture','fixture','fixture',clock_timestamp(),'FINISHED')`,
      );
      await db.query(
        `INSERT INTO pr_model_calls(id,execution_id,call_index,record,start_hash)
         VALUES('fixture','fixture',1,'{"promptTokens":20,"completionTokens":5}','fixture')`,
      );
    }
    const requests = (
      await db.query(
        historical
          ? 'SELECT * FROM pr_verification_requests ORDER BY request_id'
          : 'SELECT 1 WHERE false',
      )
    ).rows;
    const tasks = (
      await db.query(
        historical ? 'SELECT * FROM pr_tasks' : 'SELECT 1 WHERE false',
      )
    ).rows;
    const executions = (
      await db.query(
        historical ? 'SELECT * FROM pr_executions' : 'SELECT 1 WHERE false',
      )
    ).rows;
    const calls = (
      await db.query(
        historical ? 'SELECT * FROM pr_model_calls' : 'SELECT 1 WHERE false',
      )
    ).rows;
    for (let startup = 0; startup < 2; startup++) {
      await db.start();
      const relations = await db.query<{
        name: string;
        relation: string | null;
      }>(
        'SELECT name,to_regclass(name) AS relation FROM unnest($1::text[]) AS name',
        [RETIRED_RELATIONS],
      );
      for (const row of relations.rows)
        assert.equal(row.relation, null, row.name);
      assert.equal(
        (
          await db.query('SELECT version FROM pr_migrations WHERE version=$1', [
            ANALYSIS_REMOVAL_VERSION,
          ])
        ).rowCount,
        1,
      );
      assert.deepEqual(
        (
          await db.query(
            'SELECT * FROM pr_verification_requests ORDER BY request_id',
          )
        ).rows,
        requests,
      );
      assert.deepEqual((await db.query('SELECT * FROM pr_tasks')).rows, tasks);
      assert.deepEqual(
        (await db.query('SELECT * FROM pr_executions')).rows,
        executions,
      );
      assert.deepEqual(
        (await db.query('SELECT * FROM pr_model_calls')).rows,
        calls,
      );
      if (startup === 0) {
        await db.close();
        db = new Database(url.toString());
      }
    }
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
}

// 范围：真实 PostgreSQL 删除所有状态的历史分析及索引，保留原报告与执行用量并支持重启；不验证生产部署或备份恢复。
test('旧库升级删除全部分析数据并保留验证事实', async () => {
  await verifyMigration(true);
});

// 范围：空库执行完整迁移链后没有分析表，重启不会重建；不运行真实 Agent 或浏览器。
test('空库初始化及重启不保留报告分析表', async () => {
  await verifyMigration(false);
});
