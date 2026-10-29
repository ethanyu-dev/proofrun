import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { Database } from '../src/db.js';
import { task } from './fixture.js';

// 范围：独立数据库中验证退役数据的物理删除、资源关闭阻断、混合请求保留与重复启动；不关闭真实浏览器或删除真实文件。
test(
  '移除退役执行及关联历史，保留单 LLM 源任务和混合请求成员',
  { timeout: 30000 },
  async () => {
    assert.ok(process.env.PROOFRUN_TEST_DATABASE_URL);
    const admin = new pg.Pool({
      connectionString: process.env.PROOFRUN_TEST_DATABASE_URL,
    });
    const name = `proofrun_remove_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.PROOFRUN_TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    const sql = new pg.Client({ connectionString: url.toString() });
    await sql.connect();
    try {
      const migrations = new URL('../migrations/', import.meta.url);
      await sql.query(
        'CREATE TABLE pr_migrations(version integer PRIMARY KEY)',
      );
      for (const file of (await readdir(migrations))
        .filter((f) => /^0\d\d-.*\.sql$/.test(f) && Number(f.slice(0, 3)) <= 42)
        .sort()) {
        await sql.query(await readFile(new URL(file, migrations), 'utf8'));
        await sql.query('INSERT INTO pr_migrations VALUES($1)', [
          Number(file.slice(0, 3)),
        ]);
      }
      for (const [id, extra] of [
        ['source', {}],
        ['comparison-unrelated-jev', {}],
        [
          'pair',
          { comparison: { id: 'pair', arm: 'llm', sourceTaskId: 'source' } },
        ],
        [
          'sibling',
          {
            executionMode: 'jev',
            comparison: { id: 'pair', arm: 'jev', sourceTaskId: 'source' },
          },
        ],
        ['standalone', { executionMode: 'jev' }],
        ['cleanup', { purpose: 'cleanup', parentTaskId: 'sibling' }],
      ] as const) {
        await sql.query(
          "INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at) VALUES($1,$2,'fixture','COMPLETED',now())",
          [
            id,
            { ...task('fixture'), taskId: id, executionMode: 'llm', ...extra },
          ],
        );
      }
      await sql.query(`INSERT INTO pr_case_cleanups(parent_task_id,task_id,definition,state) VALUES('sibling','cleanup','{}','SKIPPED');
      INSERT INTO pr_verification_requests(request_id,title,definition_hash) VALUES('mixed','mixed','x'),('retired','retired','x'),('normal','normal','x');
      UPDATE pr_verification_requests SET source_request_id='retired' WHERE request_id='normal';
      INSERT INTO pr_verification_request_cases(request_id,case_id,task_id,position,definition_hash,execution_origin) VALUES
      ('mixed','normal','source',0,'x','created'),('mixed','old','pair',1,'x','created'),('retired','old','pair',0,'x','created');
      INSERT INTO pr_verification_request_arms(request_id,case_id,task_id,execution_mode) VALUES('mixed','old','sibling','jev'),('retired','old','sibling','jev');
      INSERT INTO pr_nodes(id,name,pool,credential_hash) VALUES('node','fixture','fixture','x');
      INSERT INTO pr_executions(id,task_id,worker_id,token_hash,lease_expires_at,state) VALUES('execution','sibling','fixture','x',now(),'FINISHED');
      INSERT INTO pr_sessions(id,execution_id,node_id,node_epoch,lease_id,fence,state) VALUES('session','execution','node','epoch','lease',1,'CLOSED');
      INSERT INTO pr_commands(id,execution_id,session_id,node_id,kind,request_hash,envelope,deadline_at,result) VALUES('command','execution','session','node','browser.observe','x','{}',now(),'{}');
      INSERT INTO pr_artifacts(id,node_id,execution_id,session_id,command_id,kind,hash,state) VALUES('artifact','node','execution','session','command','DOM','x','AVAILABLE');
      INSERT INTO pr_node_inbox(node_id,message_id,payload_hash,payload) VALUES('node','message','x','{"artifactId":"artifact"}');
      INSERT INTO pr_model_calls(id,execution_id,call_index,record,start_hash) VALUES('call','execution',1,'{}','x');
      INSERT INTO pr_public_calls(principal_id,namespace,call_key,input_hash,result,resources) VALUES('p','operation','old','x','{}','{"runs":["pair"]}'),('p','operation','normal','x','{}','{"runs":["source"]}'),('p','operation','mixed','x','{}','{"requests":["mixed"]}');
      INSERT INTO pr_public_owners(kind,resource_id,principal_id) VALUES('run','pair','p'),('run','source','p');
      INSERT INTO pr_feishu_destinations(id,app_id,chat_id) VALUES('destination','app','chat');
      INSERT INTO pr_feishu_runs(destination_id,run_key) VALUES('destination','pair'),('destination','request:mixed'),('destination','request:retired'),('destination','request:retired:hash'),('destination','request:mixed:hash');
      INSERT INTO pr_feishu_messages(id,destination_id,run_key,event_key,event,occurred_at) VALUES('message','destination','request:mixed','submitted','{}',now()),('old-rerun','destination','request:retired:hash','submitted','{}',now());`);
      const blocked = new Database(url.toString());
      try {
        await assert.rejects(blocked.start(), /RETIRED_EXECUTION_ACTIVE/);
      } finally {
        await blocked.close();
      }
      assert.equal(
        (await sql.query('SELECT max(version) n FROM pr_migrations')).rows[0].n,
        42,
      );
      assert.equal(
        (await sql.query('SELECT count(*)::int n FROM pr_tasks')).rows[0].n,
        6,
      );
      await sql.query('UPDATE pr_sessions SET closure_verified=true');
      for (let attempt = 0; attempt < 2; attempt++) {
        const db = new Database(url.toString());
        try {
          await db.start();
        } finally {
          await db.close();
        }
      }
      assert.deepEqual(
        (await sql.query('SELECT id FROM pr_tasks ORDER BY id')).rows.map(
          (r) => r.id,
        ),
        ['comparison-unrelated-jev', 'source'],
      );
      assert.deepEqual(
        (
          await sql.query(
            'SELECT request_id FROM pr_verification_requests ORDER BY request_id',
          )
        ).rows.map((r) => r.request_id),
        ['mixed', 'normal'],
      );
      assert.equal(
        (
          await sql.query(
            "SELECT source_request_id FROM pr_verification_requests WHERE request_id='normal'",
          )
        ).rows[0].source_request_id,
        null,
      );
      assert.equal(
        (
          await sql.query(
            "SELECT to_regclass('pr_verification_request_arms') n",
          )
        ).rows[0].n,
        null,
      );
      for (const table of [
        'pr_executions',
        'pr_sessions',
        'pr_commands',
        'pr_artifacts',
        'pr_model_calls',
        'pr_node_inbox',
        'pr_case_cleanups',
        'pr_feishu_messages',
      ])
        assert.equal(
          (await sql.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
          0,
          table,
        );
      assert.deepEqual(
        (await sql.query('SELECT call_key FROM pr_public_calls')).rows,
        [{ call_key: 'normal' }],
      );
      assert.deepEqual(
        (await sql.query('SELECT resource_id FROM pr_public_owners')).rows,
        [{ resource_id: 'source' }],
      );
      assert.deepEqual(
        (
          await sql.query(
            'SELECT run_key,settled_at IS NOT NULL AS settled FROM pr_feishu_runs ORDER BY run_key',
          )
        ).rows,
        [
          { run_key: 'request:mixed', settled: true },
          { run_key: 'request:mixed:hash', settled: true },
        ],
      );
      await assert.rejects(
        sql.query(
          'UPDATE pr_tasks SET definition=definition || \'{"executionMode":"jev"}\'',
        ),
        /pr_tasks_llm_only/,
      );
    } finally {
      await sql.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    }
  },
);
