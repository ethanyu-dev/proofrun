import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { task } from './fixture.js';

/** 只在独立临时 PostgreSQL 验证迁移和归属；不访问模型、浏览器或真实业务数据。 */
const ADMIN = 'current-execution-admin-fixture';

// 范围：遗留清理阻止升级、回滚后可继续升级、当前归属单写和当前运行复用；不验证真实清理动作。
test(
  '执行收敛迁移保持当前数据并只写一次当前运行关联',
  { timeout: 30_000 },
  async () => {
    assert.ok(process.env.PROOFRUN_TEST_DATABASE_URL);
    const admin = new pg.Pool({
      connectionString: process.env.PROOFRUN_TEST_DATABASE_URL,
    });
    const name = `proofrun_current_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.PROOFRUN_TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    const sql = new pg.Client({ connectionString: url.toString() });
    await sql.connect();
    const root = await mkdtemp(join(tmpdir(), 'proofrun-current-'));
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      const migrations = new URL('../migrations/', import.meta.url);
      await sql.query(
        'CREATE TABLE pr_migrations(version integer PRIMARY KEY)',
      );
      for (const file of (await readdir(migrations))
        .filter((f) => /^0\d\d-.*\.sql$/.test(f) && Number(f.slice(0, 3)) <= 32)
        .sort()) {
        await sql.query(await readFile(new URL(file, migrations), 'utf8'));
        await sql.query('INSERT INTO pr_migrations(version) VALUES($1)', [
          Number(file.slice(0, 3)),
        ]);
      }
      const parent = task('fixture');
      await sql.query(
        "INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at) VALUES($1,$2,'fixture','COMPLETED',clock_timestamp())",
        [parent.taskId, parent],
      );
      await sql.query(
        'INSERT INTO pr_case_cleanups(parent_task_id,task_id,definition) VALUES($1,$2,$3)',
        [parent.taskId, 'legacy-cleanup', { purpose: 'cleanup' }],
      );
      const blocked = new Database(url.toString());
      try {
        await assert.rejects(blocked.start(), /LEGACY_CLEANUP_PENDING/);
      } finally {
        await blocked.close();
      }
      assert.equal(
        (await sql.query('SELECT max(version) AS n FROM pr_migrations')).rows[0]
          .n,
        32,
      );
      assert.equal(
        (await sql.query('SELECT state FROM pr_case_cleanups')).rows[0].state,
        'PENDING',
      );
      // 仅模拟旧版本已明确处理遗留意图；新迁移本身不做此业务决定。
      await sql.query("UPDATE pr_case_cleanups SET state='SKIPPED'");
      // 范围：原始任务显式资源锁在升级时不能被静默忽略；不证明真实业务互斥效果。
      await sql.query(
        'UPDATE pr_tasks SET state=\'QUEUED\',definition=definition || \'{"resourceKey":"legacy"}\'::jsonb WHERE id=$1',
        [parent.taskId],
      );
      const locked = new Database(url.toString());
      try {
        await assert.rejects(locked.start(), /LEGACY_RESOURCE_LOCK_PENDING/);
      } finally {
        await locked.close();
      }
      await sql.query("UPDATE pr_tasks SET state='COMPLETED' WHERE id=$1", [
        parent.taskId,
      ]);
      app = await buildApp(
        {
          databaseUrl: url.toString(),
          adminToken: ADMIN,
          workerToken: 'current-worker-fixture',
          publicUrl: 'http://localhost',
          artifactDirectory: root,
          host: '127.0.0.1',
          port: 0,
          workerLeaseMs: 15000,
          nodeLeaseMs: 20000,
          tickMs: 1000,
          caseProfile: {
            environment: { id: 'fixture', nodePool: 'fixture' },
            budget: { timeoutMs: 60000, maxActions: 20 },
            executionMode: 'llm',
            evidenceKinds: ['DOM'],
          },
        },
        { logger: false },
      );
      const input = {
        caseId: 'current',
        platform: '夹具',
        entry: 'https://example.test',
        session: { mode: 'guest' },
        steps: [
          {
            type: 'verification',
            url: 'https://example.test',
            exec_order: 1,
            description: '读取页面',
            policy: [],
            expected: ['显示文案'],
          },
        ],
        cleanup: [],
      };
      const submit = async (requestId: string) => {
        const result = await app!.inject({
          method: 'POST',
          url: '/v2/cases',
          headers: { authorization: `Bearer ${ADMIN}` },
          payload: { requestId, cases: [input] },
        });
        assert.equal(result.statusCode, 202, result.body);
        return result.json();
      };
      await submit('current-request');
      assert.equal(
        (
          await sql.query(
            "SELECT (to_regclass('pr_verification_request_arms') IS NOT NULL)::int AS n",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (await sql.query('SELECT count(*)::int AS n FROM pr_request_runs'))
          .rows[0].n,
        1,
      );
      assert.equal(
        (
          await sql.query(
            "SELECT definition ? 'resourceKey' AS present FROM pr_tasks WHERE id='case-v2-current'",
          )
        ).rows[0].present,
        false,
      );
      await sql.query(
        "DELETE FROM pr_request_summary_dirty WHERE request_id='current-request'",
      );
      await sql.query(
        "UPDATE pr_tasks SET state='CANCELLED' WHERE id='case-v2-current'",
      );
      assert.equal(
        (
          await sql.query(
            "SELECT count(*)::int AS n FROM pr_request_summary_dirty WHERE request_id='current-request'",
          )
        ).rows[0].n,
        1,
      );
      const reused = await submit('current-reuse');
      assert.deepEqual(
        reused.cases[0].arms.map(
          (a: { executionMode: string }) => a.executionMode,
        ),
        ['llm'],
      );
      assert.equal(
        (await sql.query('SELECT count(*)::int AS n FROM pr_case_cleanups'))
          .rows[0].n,
        1,
      );
    } finally {
      await app?.close();
      await sql.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
