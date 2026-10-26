import { seedHistoricalPair } from './historical-comparison.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { dashboardToday, type VerificationCaseV2 } from '@proofrun/contracts';
import { buildApp } from '../src/app.js';
import { task } from './fixture.js';
import { compileCase } from '../src/modules/cases/structured.js';
import type { CaseProfile } from '../src/modules/cases/profile.js';
import { canonical, digest } from '../src/domain.js';

/** 测试只连接独立临时库；业务状态与用量为注入夹具，不调用浏览器或模型。 */
const DATABASE_URL = process.env.PROOFRUN_TEST_DATABASE_URL;
const ADMIN = 'case-run-admin-fixture';
const PROFILE: CaseProfile = {
  environment: { id: 'fixture', nodePool: 'fixture' },
  budget: { timeoutMs: 60000, maxActions: 20 },
  executionMode: 'llm' as const,
  evidenceKinds: ['DOM' as const],
};
/** 固定业务定义用于确认重跑不会复制出新的业务 case。 */
function example(caseId: string): VerificationCaseV2 {
  return {
    caseId,
    platform: '运行回归夹具',
    entry: 'https://example.test',
    session: { mode: 'guest' },
    steps: [
      {
        stepId: 'check',
        type: 'verification',
        url: 'https://example.test',
        exec_order: 1,
        description: '检查结果',
        policy: [],
        expected: ['显示结果'],
      },
    ],
    cleanup: [],
  };
}

// 范围：真实旧库升级、HTTP、事务、计量和共享归属；报告直接写库，不代表真实浏览器验收。
test('稳定 case 运行历史与软删除集成', { timeout: 60_000 }, async (suite) => {
  assert.ok(DATABASE_URL, '需要独立测试 PostgreSQL');
  const admin = new pg.Pool({ connectionString: DATABASE_URL });
  const name = `proofrun_runs_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  const sql = new pg.Client({ connectionString: url.toString() });
  await sql.connect();
  const root = await mkdtemp(join(tmpdir(), 'proofrun-runs-'));
  // 先按发布前的真实迁移构建旧库并写入历史记录，再让应用执行新迁移。
  const migrations = new URL('../migrations/', import.meta.url);
  await sql.query(
    'CREATE TABLE pr_migrations(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())',
  );
  for (const file of (await readdir(migrations))
    .filter((f) => /^0\d\d-.*\.sql$/.test(f) && Number(f.slice(0, 3)) < 32)
    .sort()) {
    await sql.query(await readFile(new URL(file, migrations), 'utf8'));
    await sql.query('INSERT INTO pr_migrations(version) VALUES($1)', [
      Number(file.slice(0, 3)),
    ]);
  }
  const legacy = compileCase(example('legacy'), {
    ...PROFILE,
    executionMode: 'llm',
  });
  await sql.query(
    `INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at,created_at,finished_at) VALUES($1,$2,$3,'COMPLETED',clock_timestamp(),date_trunc('day',clock_timestamp() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai',clock_timestamp())`,
    [legacy.taskId, legacy, digest(canonical(legacy))],
  );
  const app = await buildApp(
    {
      databaseUrl: url.toString(),
      adminToken: ADMIN,
      workerToken: 'run-worker-fixture',
      publicUrl: 'http://localhost',
      artifactDirectory: root,
      host: '127.0.0.1',
      port: 0,
      workerLeaseMs: 15000,
      nodeLeaseMs: 20000,
      tickMs: 1000,
      caseProfile: PROFILE,
    },
    { logger: false },
  );
  const call = (path: string, body?: unknown) =>
    app.inject({
      method: body === undefined ? 'GET' : 'POST',
      url: path,
      headers: { authorization: `Bearer ${ADMIN}` },
      ...(body === undefined ? {} : { payload: body as object }),
    });
  const read = async (path: string) => {
    const r = await call(path);
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const submit = async (requestId: string, cases: string[]) => {
    const r = await call('/v2/cases', { requestId, cases: cases.map(example) });
    assert.equal(r.statusCode, 202, r.body);
    for (const id of cases) await seedHistoricalPair(sql, `case-v2-${id}`);
    return r.json();
  };
  /** 报告结果与历史汇总用量为测试输入，只验证数据库过滤和聚合。 */
  async function finish(runId: string, verdict = 'PASSED', tokens = 50) {
    const rows = (
      await sql.query(
        `SELECT id,definition FROM pr_tasks WHERE id=$1 OR definition#>>'{comparison,sourceTaskId}'=$1`,
        [runId],
      )
    ).rows;
    for (const row of rows) {
      const report = {
        executionDisposition: 'EXECUTED',
        verdict,
        summary: '夹具报告',
        artifacts: [],
        criteria: row.definition.acceptanceCriteria.map(
          (c: { id: string }) => ({
            criterionId: c.id,
            verdict,
            summary: '夹具',
            evidenceRefs: [],
          }),
        ),
        steps: [
          {
            stepId: 'check',
            status: 'COMPLETED',
            summary: '夹具',
            evidenceRefs: [],
            criteria: [],
            startedAt: null,
            finishedAt: null,
          },
        ],
        executionDetails: {
          promptTokens: tokens,
          completionTokens: 10,
          modelCalls: 1,
          model: 'fixture',
        },
      };
      await sql.query(
        "UPDATE pr_tasks SET state='COMPLETED',finished_at=clock_timestamp(),report=$2 WHERE id=$1",
        [row.id, report],
      );
    }
  }
  const statistics = () =>
    read(`/v1/admin/statistics?period=day&date=${dashboardToday()}`);
  try {
    // 范围：旧库不改写身份即可生成首轮历史；不检查旧业务报告的真实性。
    await suite.test('历史数据自动成为首轮运行', async () => {
      const current = await read('/v2/cases/legacy');
      assert.equal(current.caseId, 'legacy');
      assert.equal(current.runId, legacy.taskId);
      const history = await read('/v2/cases/legacy/runs');
      assert.deepEqual(
        history.runs.map((r: { runId: string }) => r.runId),
        [legacy.taskId],
      );
      assert.deepEqual(
        (
          await sql.query('SELECT definition FROM pr_tasks WHERE id=$1', [
            legacy.taskId,
          ])
        ).rows[0].definition,
        legacy,
      );
      await finish(legacy.taskId, 'FAILED');
    });
    // 范围：并发重复写入只新增一次运行，当前与历史读取隔离；不运行调度器浏览器会话。
    await suite.test('重跑保留 caseId，幂等且支持读取历史', async () => {
      const before = await statistics();
      const result = await Promise.all([
        call('/v2/cases/legacy/rerun', { runId: 'second' }),
        call('/v2/cases/legacy/rerun', { runId: 'second' }),
      ]);
      for (const r of result) {
        assert.equal(r.statusCode, 202, r.body);
        assert.equal(r.json().caseId, 'legacy');
        assert.equal(r.json().taskId, 'case-run-second');
      }
      assert.equal((await read('/v2/cases/legacy/runs')).runs.length, 2);
      assert.equal((await read('/v2/cases/legacy')).runId, 'case-run-second');
      assert.equal(
        (await read(`/v2/cases/legacy?runId=${legacy.taskId}`)).result.outcome,
        'FAILED',
      );
      assert.equal(
        (await call('/v2/cases/legacy?runId=unrelated')).statusCode,
        404,
      );
      const after = await statistics();
      assert.equal(after.summary.cases.total, before.summary.cases.total);
      assert.equal(after.summary.runs, before.summary.runs + 1);
      await finish('case-run-second');
      assert.equal((await statistics()).summary.cases.passed, 1);
    });
    // 范围：删除最新运行回退旧结果、排除旧汇总用量、重复删除幂等；不物理清理文件。
    await suite.test('删除最新运行回退并排除统计', async () => {
      const before = await statistics();
      const removed = await call('/v1/tasks/case-run-second/delete', {});
      assert.equal(removed.statusCode, 200, removed.body);
      assert.equal((await read('/v2/cases/legacy')).runId, legacy.taskId);
      assert.equal((await read('/v2/cases/legacy/runs')).runs.length, 1);
      assert.equal((await call('/v1/tasks/case-run-second')).statusCode, 404);
      assert.equal((await read('/v1/tasks?q=case-run-second')).tasks.length, 0);
      assert.equal(
        (await call('/v1/tasks/case-run-second/delete', {})).statusCode,
        200,
      );
      assert.equal(
        (await call('/v2/cases/legacy/rerun', { runId: 'second' })).statusCode,
        409,
      );
      const after = await statistics();
      assert.equal(after.summary.cases.failed, 1);
      assert.equal(after.summary.runs, before.summary.runs - 1);
      assert.equal(
        after.summary.tokens.totalTokens,
        before.summary.tokens.totalTokens - 60,
      );
      assert.ok(
        (
          await sql.query(
            "SELECT report FROM pr_tasks WHERE id='case-run-second'",
          )
        ).rows[0].report,
      );
    });
    // 范围：批量全成全败、双跑成组删除和摘要失效；用量与报告均为夹具。
    await suite.test('批量删除原子校验并同步请求汇总', async () => {
      await submit('batch', ['alpha', 'beta']);
      await finish('case-v2-alpha');
      let r = await call('/v1/tasks/delete', {
        ids: ['case-v2-alpha', 'case-v2-beta'],
      });
      assert.equal(r.statusCode, 409, r.body);
      assert.equal((await call('/v1/tasks/case-v2-alpha')).statusCode, 200);
      await finish('case-v2-beta');
      await read('/v2/requests');
      const before = await statistics();
      r = await call('/v1/tasks/delete', {
        ids: ['comparison-case-v2-alpha-jev', 'case-v2-alpha'],
      });
      assert.equal(r.statusCode, 200, r.body);
      assert.equal(r.json().deletedTaskIds.length, 2);
      const detail = await read('/v2/requests/batch');
      assert.equal(detail.caseCount, 1);
      assert.equal(detail.cases[0].caseId, 'beta');
      const list = await read('/v2/requests');
      assert.equal(
        list.requests.find(
          (r: { requestId: string }) => r.requestId === 'batch',
        ).caseCount,
        1,
      );
      const after = await statistics();
      assert.equal(
        after.summary.tokens.totalTokens,
        before.summary.tokens.totalTokens - 120,
      );
      assert.equal(
        (await call('/v1/tasks/delete', { ids: ['case-v2-beta', 'missing'] }))
          .statusCode,
        404,
      );
      assert.equal((await call('/v1/tasks/case-v2-beta')).statusCode, 200);
    });
    // 范围：请求软删除不破坏共享执行，最后引用删除才排除执行；不模拟跨部署进程。
    await suite.test(
      '共享请求删除保留其他引用，并发删除最后引用不遗留统计',
      async () => {
        await submit('shared-a', ['shared']);
        await submit('shared-b', ['shared']);
        await finish('case-v2-shared');
        assert.equal(
          (await call('/v2/requests/shared-a/delete', {})).statusCode,
          200,
        );
        assert.equal((await call('/v2/requests/shared-a')).statusCode, 404);
        assert.equal((await read('/v2/requests/shared-b')).caseCount, 1);
        assert.equal((await call('/v1/tasks/case-v2-shared')).statusCode, 200);
        assert.equal(
          (await call('/v2/requests/shared-b/delete', {})).statusCode,
          200,
        );
        assert.equal((await call('/v1/tasks/case-v2-shared')).statusCode, 404);
        await submit('concurrent-a', ['concurrent']);
        await submit('concurrent-b', ['concurrent']);
        await finish('case-v2-concurrent');
        const responses = await Promise.all(
          ['concurrent-a', 'concurrent-b'].map((id) =>
            call(`/v2/requests/${id}/delete`, {}),
          ),
        );
        for (const r of responses) assert.equal(r.statusCode, 200, r.body);
        assert.equal(
          (await call('/v1/tasks/case-v2-concurrent')).statusCode,
          404,
        );
      },
    );
    // 范围：详情入口的请求删除原子排除全部当前 case、双跑和统计，重复调用幂等；报告为夹具，不清理真实证据文件。
    await suite.test('删除已结束请求及下属执行后不再纳入统计', async () => {
      await submit('detail-delete', ['detail-delete-a', 'detail-delete-b']);
      await finish('case-v2-detail-delete-a');
      const path = '/v2/requests/detail-delete/delete';
      const blocked = await call(path, {});
      assert.equal(blocked.statusCode, 409, blocked.body);
      assert.equal(blocked.json().code, 'TASK_ACTIVE');
      assert.equal((await read('/v2/requests/detail-delete')).caseCount, 2);
      assert.equal(
        (await call('/v1/tasks/case-v2-detail-delete-a')).statusCode,
        200,
      );
      await finish('case-v2-detail-delete-b');
      const before = await statistics();
      const removed = await call(path, {});
      assert.equal(removed.statusCode, 200, removed.body);
      assert.deepEqual(removed.json().deletedRequestIds, ['detail-delete']);
      assert.equal(removed.json().deletedTaskIds.length, 4);
      for (const taskId of removed.json().deletedTaskIds)
        assert.equal((await call(`/v1/tasks/${taskId}`)).statusCode, 404);
      assert.equal((await call('/v2/requests/detail-delete')).statusCode, 404);
      assert.equal(
        (await call('/v2/requests/detail-delete/report')).statusCode,
        404,
      );
      assert.ok(
        !(await read('/v2/requests')).requests.some(
          (item: { requestId: string }) => item.requestId === 'detail-delete',
        ),
      );
      for (const id of ['detail-delete-a', 'detail-delete-b'])
        assert.equal((await call(`/v2/cases/${id}`)).statusCode, 404);
      const after = await statistics();
      assert.equal(after.summary.cases.total, before.summary.cases.total - 2);
      assert.equal(after.summary.cases.passed, before.summary.cases.passed - 2);
      assert.equal(after.summary.runs, before.summary.runs - 2);
      assert.equal(
        after.summary.tokens.totalTokens,
        before.summary.tokens.totalTokens - 240,
      );
      assert.equal((await call(path, {})).statusCode, 200);
      assert.deepEqual((await statistics()).summary, after.summary);
      const records = (
        await sql.query(
          'SELECT deleted_at,report FROM pr_tasks WHERE id=ANY($1)',
          [removed.json().deletedTaskIds],
        )
      ).rows;
      assert.ok(records.every((row) => row.deleted_at && row.report));
    });
    // 范围：整请求重跑保持成员 caseId、旧请求保留旧运行快照；不验证真实任务执行。
    await suite.test('整个请求重跑只新增运行', async () => {
      await submit('original', ['request-case']);
      await finish('case-v2-request-case', 'FAILED');
      const body = {
        requestId: 'new-request',
        caseIds: [{ sourceCaseId: 'request-case', runId: 'request-run' }],
      };
      const response = await call('/v2/requests/original/rerun', body);
      assert.equal(response.statusCode, 202, response.body);
      const current = response.json();
      assert.equal(current.cases[0].caseId, 'request-case');
      assert.equal(current.cases[0].arms[0].taskId, 'case-run-request-run');
      assert.equal(
        (await read('/v2/requests/original')).cases[0].arms[0].taskId,
        'case-v2-request-case',
      );
      assert.equal(
        (await call('/v2/requests/original/rerun', body)).statusCode,
        202,
      );
      assert.equal((await read('/v2/cases/request-case/runs')).runs.length, 2);
    });
    // 范围：旧独立清理、真实调用记录及会话关闭闸门；节点和调用均为数据库夹具。
    await suite.test('旧清理随整轮删除，未关闭会话拒绝删除', async () => {
      await submit('cleanup-request', ['cleanup-case']);
      await finish('case-v2-cleanup-case');
      const parent = 'comparison-case-v2-cleanup-case-jev';
      const definition = (
        await sql.query('SELECT definition FROM pr_tasks WHERE id=$1', [parent])
      ).rows[0].definition;
      const cleanup = {
        ...definition,
        taskId: 'old-cleanup',
        purpose: 'cleanup',
        parentTaskId: parent,
      };
      delete cleanup.caseV2Definition;
      delete cleanup.comparison;
      await sql.query(
        "INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at,finished_at) VALUES('old-cleanup',$1,'fixture','COMPLETED',clock_timestamp(),clock_timestamp())",
        [cleanup],
      );
      await sql.query(
        "INSERT INTO pr_case_cleanups(parent_task_id,task_id,definition,state) VALUES($1,'old-cleanup',$2,'QUEUED')",
        [parent, cleanup],
      );
      await sql.query(
        "INSERT INTO pr_executions(id,task_id,worker_id,token_hash,lease_expires_at,state) VALUES('cleanup-execution','old-cleanup','fixture','fixture',clock_timestamp(),'FINISHED')",
      );
      await sql.query(
        "INSERT INTO pr_model_calls(id,execution_id,call_index,record,start_hash) VALUES('cleanup-call','cleanup-execution',1,$1,'fixture')",
        [{ promptTokens: 123, completionTokens: 4 }],
      );
      await sql.query(
        "INSERT INTO pr_nodes(id,name,credential_hash,pool,capabilities) VALUES('cleanup-node','清理夹具','fixture','fixture','{}')",
      );
      await sql.query(
        "INSERT INTO pr_sessions(id,execution_id,node_id,node_epoch,lease_id,fence,state) VALUES('cleanup-session','cleanup-execution','cleanup-node','epoch','lease',1,'CLOSING')",
      );
      assert.equal(
        (await call('/v1/tasks/old-cleanup/delete', {})).statusCode,
        409,
      );
      await sql.query(
        "UPDATE pr_sessions SET closure_verified=true,state='CLOSED' WHERE id='cleanup-session'",
      );
      const before = await statistics();
      const removed = await call('/v1/tasks/old-cleanup/delete', {});
      assert.equal(removed.statusCode, 200, removed.body);
      assert.deepEqual(
        new Set(removed.json().deletedTaskIds),
        new Set(['case-v2-cleanup-case', parent, 'old-cleanup']),
      );
      assert.equal(
        (await statistics()).summary.tokens.totalTokens,
        before.summary.tokens.totalTokens - 247,
      );
      assert.equal(
        (
          await sql.query(
            "SELECT count(*)::int AS n FROM pr_model_calls WHERE id='cleanup-call'",
          )
        ).rows[0].n,
        1,
      );
    });
    // 范围：旧普通任务的 sourceTaskId 是溯源身份，删除仅按 comparison.id 成组；不执行真实对比。
    await suite.test('历史对照运行删除同时移除两组', async () => {
      const original = { ...task('fixture'), taskId: 'ordinary-source' };
      assert.equal((await call('/v1/tasks', original)).statusCode, 202);
      // 历史比较直接导入，退役入口不会再生成双跑。
      assert.equal(
        (await call('/v1/tasks', { ...original, taskId: 'historical-pair' }))
          .statusCode,
        202,
      );
      await seedHistoricalPair(sql, 'historical-pair', 'ordinary-source');
      await sql.query(
        "UPDATE pr_tasks SET state='COMPLETED',finished_at=clock_timestamp() WHERE id IN ('ordinary-source','historical-pair','comparison-historical-pair-jev')",
      );
      const removed = await call(
        '/v1/tasks/comparison-historical-pair-jev/delete',
        {},
      );
      assert.equal(removed.statusCode, 200, removed.body);
      assert.deepEqual(
        new Set(removed.json().deletedTaskIds),
        new Set(['historical-pair', 'comparison-historical-pair-jev']),
      );
      assert.equal((await call('/v1/tasks/ordinary-source')).statusCode, 200);
    });
    // 范围：旧 v1 case 删除后不从兼容读取和幂等提交入口重新出现；不运行浏览器。
    await suite.test('旧 case 兼容入口隐藏已删除记录并拒绝重提', async () => {
      const input = {
        caseId: 'legacy-v1',
        description: '旧版夹具',
        url: 'https://example.test',
        steps: ['检查页面'],
        acceptanceCriteria: [
          { id: 'visible', description: '结果', expectedResult: '显示结果' },
        ],
      };
      assert.equal((await call('/v1/cases', input)).statusCode, 202);
      await sql.query(
        "UPDATE pr_tasks SET state='COMPLETED',finished_at=clock_timestamp() WHERE definition#>>'{caseDefinition,caseId}'='legacy-v1'",
      );
      assert.equal(
        (await call('/v1/tasks/case-legacy-v1/delete', {})).statusCode,
        200,
      );
      assert.equal((await call('/v1/cases/legacy-v1')).statusCode, 404);
      assert.equal((await call('/v1/cases', input)).statusCode, 409);
      assert.equal(
        (await call('/v1/tasks/case-legacy-v1/comparison')).statusCode,
        404,
      );
    });
    // 范围：管理员权限与批量上限；无外部账户或生产数据访问。
    await suite.test('删除接口鉴权和参数边界', async () => {
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/tasks/delete',
            payload: { ids: [legacy.taskId] },
          })
        ).statusCode,
        401,
      );
      for (const ids of [
        [],
        ['bad/path'],
        Array(101).fill(legacy.taskId),
        null,
      ])
        assert.equal((await call('/v1/tasks/delete', { ids })).statusCode, 400);
    });
  } finally {
    await app.close();
    await sql.end();
    await rm(root, { recursive: true, force: true });
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
