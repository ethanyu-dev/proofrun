import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { Database } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { task } from './fixture.js';

/** 仅在随机临时数据库和本地注入请求中使用，不是真实服务凭据。 */
const ADMIN = 'proofrun-retire-v3-admin-fixture-only';
const WORKER = 'proofrun-retire-v3-worker-fixture-only';
/** 退役表必须消失，共享执行、历史报告和 DevPass 数据不能被连带删除。 */
const RETIRED_TABLES = [
  'pr_external_operations',
  'pr_external_controllers',
  'pr_public_calls',
  'pr_public_owners',
];

// 范围：真实 PostgreSQL 的升级阻断、回滚、历史保留及重复启动；HTTP 使用注入，不代表生产或物理浏览器关闭验收。
test(
  'v3 退役迁移拒绝遗留资源，保留历史与 v2 并关闭全部外部入口',
  { timeout: 30000 },
  async () => {
    const address = process.env.PROOFRUN_TEST_DATABASE_URL;
    assert.ok(address);
    const admin = new pg.Pool({ connectionString: address });
    const name = `proofrun_retire_v3_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(address);
    url.pathname = `/${name}`;
    const sql = new pg.Client({ connectionString: url.toString() });
    await sql.connect();
    const directory = await mkdtemp(join(tmpdir(), 'proofrun-retire-v3-'));
    try {
      const migrations = new URL('../migrations/', import.meta.url);
      await sql.query(
        'CREATE TABLE pr_migrations(version integer PRIMARY KEY)',
      );
      for (const file of (await readdir(migrations))
        .filter((f) => /^\d{3}-.*\.sql$/.test(f) && Number(f.slice(0, 3)) <= 44)
        .sort()) {
        await sql.query(await readFile(new URL(file, migrations), 'utf8'));
        await sql.query('INSERT INTO pr_migrations VALUES($1)', [
          Number(file.slice(0, 3)),
        ]);
      }
      for (const [id, executor, state] of [
        ['legacy', 'external', 'QUEUED'],
        ['builtin', 'builtin', 'QUEUED'],
      ]) {
        await sql.query(
          "INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at,executor_kind,report) VALUES($1,$2,'fixture',$3,now()+interval '1 hour',$4,$5)",
          [
            id,
            { ...task('fixture'), taskId: id },
            state,
            executor,
            id === 'legacy' ? { summary: '保留原报告' } : null,
          ],
        );
      }
      await sql.query(`INSERT INTO pr_public_owners VALUES('run','legacy','fixture');
      INSERT INTO pr_public_calls(principal_id,namespace,call_key,input_hash,result,resources) VALUES('fixture','operation','fixture','fixture','{}','{}');
      INSERT INTO pr_external_controllers(id,run_id,principal_id,state,idle_deadline_at) VALUES('controller','legacy','fixture','ACTIVE',now());
      INSERT INTO pr_external_operations(principal_id,id,input_hash,controller_id,run_id,kind,state) VALUES('fixture','operation','fixture','controller','legacy','observe','UNKNOWN');`);
      /** 每次失败都释放实例锁，且迁移版本与原始执行类型保持不变。 */
      const blocked = async () => {
        const db = new Database(url.toString());
        try {
          await assert.rejects(db.start(), /V3_EXECUTION_ACTIVE/);
        } finally {
          await db.close();
        }
        assert.equal(
          (await sql.query('SELECT max(version) version FROM pr_migrations'))
            .rows[0].version,
          44,
        );
        assert.equal(
          (
            await sql.query(
              "SELECT executor_kind FROM pr_tasks WHERE id='legacy'",
            )
          ).rows[0].executor_kind,
          'external',
        );
      };
      await blocked();
      await sql.query("UPDATE pr_tasks SET state='RUNNING' WHERE id='legacy'");
      await blocked();
      await sql.query(
        "UPDATE pr_tasks SET state='COMPLETED' WHERE id='legacy'",
      );
      await sql.query(`INSERT INTO pr_nodes(id,name,pool,credential_hash) VALUES('node','fixture','fixture','fixture');
      INSERT INTO pr_executions(id,task_id,worker_id,token_hash,lease_expires_at,state) VALUES('execution','legacy','fixture','fixture',now(),'RUNNING');`);
      await blocked();
      await sql.query("UPDATE pr_executions SET state='FINISHED'");
      await sql.query(
        "INSERT INTO pr_sessions(id,execution_id,node_id,node_epoch,lease_id,fence,state) VALUES('session','execution','node','epoch','lease',1,'CLOSED')",
      );
      await blocked();
      await sql.query('UPDATE pr_sessions SET closure_verified=true');
      await sql.query(
        "INSERT INTO pr_external_accounts(task_id,request_id,request,provider_id,client_id,node_id,reserved_until,state) VALUES('legacy','request','{}','provider','client','node',now(),'RELEASE_PENDING')",
      );
      await blocked();
      await sql.query("UPDATE pr_external_accounts SET state='RELEASED'");
      await sql.query(`INSERT INTO pr_commands(id,execution_id,session_id,node_id,kind,request_hash,envelope,deadline_at,result) VALUES('command','execution','session','node','browser.observe','fixture','{}',now(),'{}');
      INSERT INTO pr_artifacts(id,node_id,execution_id,session_id,command_id,kind,hash,state) VALUES('artifact','node','execution','session','command','DOM','fixture','AVAILABLE');`);
      for (let attempt = 0; attempt < 2; attempt++) {
        const db = new Database(url.toString());
        try {
          await db.start();
        } finally {
          await db.close();
        }
      }
      for (const table of RETIRED_TABLES)
        assert.equal(
          (await sql.query('SELECT to_regclass($1) value', [table])).rows[0]
            .value,
          null,
        );
      assert.deepEqual(
        (await sql.query("SELECT report,state FROM pr_tasks WHERE id='legacy'"))
          .rows[0],
        { report: { summary: '保留原报告' }, state: 'COMPLETED' },
      );
      assert.equal(
        (await sql.query("SELECT state FROM pr_tasks WHERE id='builtin'"))
          .rows[0].state,
        'QUEUED',
      );
      for (const table of [
        'pr_artifacts',
        'pr_sessions',
        'pr_executions',
        'pr_external_accounts',
      ])
        assert.equal(
          (await sql.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
          1,
        );
      assert.equal(
        (
          await sql.query(
            "SELECT count(*)::int n FROM information_schema.columns WHERE table_name='pr_tasks' AND column_name IN ('executor_kind','binding_deadline_at')",
          )
        ).rows[0].n,
        0,
      );
      const app = await buildApp(
        {
          databaseUrl: url.toString(),
          adminToken: ADMIN,
          workerToken: WORKER,
          publicUrl: 'http://localhost',
          artifactDirectory: directory,
          host: '127.0.0.1',
          port: 0,
          workerLeaseMs: 4000,
          nodeLeaseMs: 4000,
          tickMs: 5000,
          caseProfile: {
            environment: { id: 'fixture', nodePool: 'fixture' },
            budget: { maxActions: 20 },
            executionMode: 'llm',
            evidenceKinds: ['DOM'],
          },
        },
        { logger: false },
      );
      try {
        // 覆盖所有旧 HTTP 资源族与两套 MCP 的常见方法，管理员凭据也不能恢复入口。
        const paths = [
          '/v3/browser/capabilities',
          '/v3/browser/tasks',
          '/v3/browser/sessions',
          '/v3/verification/capabilities',
          '/v3/verification/requests',
          '/v3/verification/requests/validate',
          '/v3/verification/requests/id',
          '/v3/verification/requests/id/reruns',
          '/v3/runs/id',
          '/v3/runs/id/cancel',
          '/v3/runs/id/controller',
          '/v3/runs/id/evidence/id',
          '/v3/runs/id/evidence/id/download',
          '/v3/operations/id',
          '/v3/execution/schema',
          ...[
            '',
            '/context',
            '/touch',
            '/close',
            '/decisions',
            '/observations',
            '/actions',
            '/waits',
            '/network',
            '/finish',
            '/interventions',
            '/steps/id/progress',
            '/steps/id/finish',
            '/steps/id/block',
          ].map((suffix) => `/v3/controllers/id${suffix}`),
          '/mcp/browser',
          '/mcp/verification',
        ];
        for (const path of paths)
          for (const method of ['GET', 'POST', 'DELETE'] as const)
            assert.equal(
              (
                await app.inject({
                  method,
                  url: path,
                  headers: { authorization: `Bearer ${ADMIN}` },
                })
              ).statusCode,
              404,
              `${method} ${path}`,
            );
        assert.equal((await app.inject('/health/ready')).statusCode, 200);
        const body = {
          requestId: 'v2-still-supported',
          cases: [
            {
              caseId: 'case',
              platform: 'fixture',
              entry: 'https://example.test',
              steps: [
                {
                  type: 'verification',
                  url: 'https://example.test',
                  exec_order: 1,
                  description: '验证入口',
                  policy: [],
                  expected: ['显示页面'],
                },
              ],
              cleanup: [],
            },
          ],
        };
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: '/v2/cases',
              payload: body,
            })
          ).statusCode,
          401,
        );
        const response = await app.inject({
          method: 'POST',
          url: '/v2/cases',
          payload: body,
          headers: { authorization: `Bearer ${ADMIN}` },
        });
        assert.equal(response.statusCode, 202, response.body);
        assert.equal(
          (
            await app.inject({
              url: '/v2/requests/v2-still-supported',
              headers: { authorization: `Bearer ${ADMIN}` },
            })
          ).statusCode,
          200,
        );
      } finally {
        await app.close();
      }
    } finally {
      await sql.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
