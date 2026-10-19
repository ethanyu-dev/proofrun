import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import {
  validateRequestResultV2,
  validateRequestList,
  type RequestResultV2,
  type VerificationCaseV2,
} from '@proofrun/contracts';
import { buildApp } from '../src/app.js';

/** 仅用于临时数据库与注入式 HTTP 的认证夹具。 */
const ADMIN = 'request-integration-admin-fixture';
const DATABASE_URL = process.env.PROOFRUN_TEST_DATABASE_URL;
/** 提供独立 case，不运行浏览器或模型；断言只覆盖协议、事务和读取。 */
function example(caseId: string): VerificationCaseV2 {
  return {
    caseId,
    platform: '请求集成夹具',
    entry: 'https://example.test',
    session: { mode: 'guest' },
    steps: [
      {
        stepId: 'check',
        type: 'verification',
        url: 'https://example.test',
        exec_order: 1,
        description: `验证 ${caseId}`,
        policy: [],
        expected: ['显示结果'],
      },
    ],
    cleanup: [],
  };
}

// 范围：真实 PostgreSQL 迁移、事务、并发、HTTP 认证与结果投影；报告事实直接注入，不代表真实业务验收。
test('请求归属、原子提交与报告汇总集成', { timeout: 60_000 }, async (suite) => {
  assert.ok(
    DATABASE_URL,
    '请设置独立测试 PostgreSQL 的 PROOFRUN_TEST_DATABASE_URL',
  );
  const admin = new pg.Pool({ connectionString: DATABASE_URL });
  const name = `proofrun_requests_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  const root = await mkdtemp(join(tmpdir(), 'proofrun-requests-'));
  const sql = new pg.Pool({ connectionString: url.toString() });
  const app = await buildApp(
    {
      databaseUrl: url.toString(),
      adminToken: ADMIN,
      workerToken: 'request-integration-worker-fixture',
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
        executionMode: 'parallel',
        evidenceKinds: ['DOM'],
      },
    },
    { logger: false },
  );
  const call = async (path: string, body?: unknown) =>
    app.inject({
      method: body === undefined ? 'GET' : 'POST',
      url: path,
      headers: { authorization: `Bearer ${ADMIN}` },
      ...(body === undefined ? {} : { payload: body as object }),
    });
  const submit = async (requestId: string, ids: string[]) => {
    const response = await call('/v2/cases', {
      requestId,
      title: '集成回归',
      cases: ids.map(example),
    });
    assert.equal(response.statusCode, 202, response.body);
    const result = response.json<RequestResultV2>();
    assert.ok(
      validateRequestResultV2(result),
      JSON.stringify(validateRequestResultV2.errors),
    );
    return result;
  };
  try {
    // 范围：双跑身份、首次顺序和对象协议；不覆盖真实调度资源。
    await suite.test('三个 case 六个执行组，只统计三个唯一验收项', async () => {
      const result = await submit('request-main', ['alpha', 'beta', 'gamma']);
      assert.equal(result.caseCount, 3);
      assert.equal(result.executionCounts.total, 6);
      assert.equal(result.uniqueCriteriaCounts.total, 3);
      assert.equal(result.uniqueCriteriaCounts.pending, 3);
      assert.equal(result.reportStatus, null);
      assert.equal(result.reportPhase, 'PENDING');
      const replay = await submit('request-main', ['gamma', 'alpha', 'beta']);
      assert.deepEqual(
        replay.cases.map((c) => c.caseId),
        ['alpha', 'beta', 'gamma'],
      );
      assert.equal(
        (await sql.query('SELECT count(*)::int AS n FROM pr_tasks')).rows[0].n,
        6,
      );
      assert.equal(
        (
          await call('/v2/cases', {
            requestId: 'request-main',
            title: '改变标题',
            cases: ['alpha', 'beta', 'gamma'].map(example),
          })
        ).statusCode,
        409,
      );
    });
    // 范围：交叉批次锁与幂等事务；不覆盖多主数据库部署。
    await suite.test(
      '并发同请求与交叉请求不会重复创建，共享成员保留来源',
      async () => {
        await Promise.all([
          submit('concurrent', ['delta', 'epsilon']),
          submit('concurrent', ['epsilon', 'delta']),
          submit('overlap', ['epsilon', 'zeta']),
        ]);
        const reused = await submit('reuse', ['alpha']);
        assert.equal(reused.cases[0]!.executionOrigin, 'reused');
        const memberships = await call('/v1/tasks/case-v2-alpha/requests');
        assert.equal(memberships.json().length, 2);
        assert.equal(
          (
            await sql.query(
              "SELECT count(*)::int AS n FROM pr_tasks WHERE id IN ('case-v2-delta','comparison-case-v2-delta-jev')",
            )
          ).rows[0].n,
          2,
        );
      },
    );
    // 范围：事务中途冲突回滚及无孤立归属；不模拟磁盘损坏。
    await suite.test('case 冲突回滚请求和新任务', async () => {
      const response = await call('/v2/cases', {
        requestId: 'conflict',
        cases: [
          example('new-before-conflict'),
          { ...example('alpha'), platform: '不同定义' },
        ],
      });
      assert.equal(response.statusCode, 409);
      assert.equal((await call('/v2/requests/conflict')).statusCode, 404);
      assert.equal(
        (
          await sql.query(
            "SELECT count(*)::int AS n FROM pr_tasks WHERE id='case-v2-new-before-conflict'",
          )
        ).rows[0].n,
        0,
      );
      // 强制在任务插入后关联成员时失败，以验证真正的事务回滚。
      await sql.query(
        "CREATE FUNCTION reject_request_member() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.case_id='rollback' THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END $$",
      );
      await sql.query(
        'CREATE TRIGGER reject_member BEFORE INSERT ON pr_verification_request_cases FOR EACH ROW EXECUTE FUNCTION reject_request_member()',
      );
      assert.equal(
        (
          await call('/v2/cases', {
            requestId: 'rollback-request',
            cases: [example('rollback')],
          })
        ).statusCode,
        503,
      );
      assert.equal(
        (await call('/v2/requests/rollback-request')).statusCode,
        404,
      );
      assert.equal(
        (
          await sql.query(
            "SELECT count(*)::int AS n FROM pr_tasks WHERE definition#>>'{caseV2Definition,caseId}'='rollback'",
          )
        ).rows[0].n,
        0,
      );
      await sql.query(
        'DROP TRIGGER reject_member ON pr_verification_request_cases',
      );
    });
    // 范围：部分报告、组间冲突、终态缺失与证据保留统计；注入报告不证明模型判断准确。
    await suite.test(
      '部分结果不提前通过，最终汇总保留失败与缺报告',
      async () => {
        const report = (id: string, verdict: 'PASSED' | 'FAILED') => ({
          protocolVersion: '0.1',
          taskId: id,
          executionDisposition: 'EXECUTED',
          verdict,
          summary: '夹具报告',
          criteria: [
            {
              criterionId: 'check-expected-1',
              verdict,
              summary: '夹具依据',
              evidenceRefs: [],
            },
          ],
          artifacts: [],
          steps: [
            {
              stepId: 'check',
              status: 'COMPLETED',
              summary: '夹具执行',
              criteria: [],
              evidenceRefs: [],
              startedAt: null,
              finishedAt: null,
            },
          ],
        });
        await sql.query(
          "UPDATE pr_tasks SET state='COMPLETED',report=$2,finished_at=clock_timestamp() WHERE id=$1",
          ['case-v2-alpha', report('case-v2-alpha', 'PASSED')],
        );
        let result = (
          await call('/v2/requests/request-main/report')
        ).json<RequestResultV2>();
        assert.equal(result.reportPhase, 'PARTIAL');
        assert.equal(result.reportStatus, null);
        assert.equal(result.uniqueCriteriaCounts.passed, 0);
        await sql.query(
          "UPDATE pr_tasks SET state='COMPLETED',report=$2 WHERE id=$1",
          [
            'comparison-case-v2-alpha-jev',
            report('comparison-case-v2-alpha-jev', 'FAILED'),
          ],
        );
        await sql.query(
          "UPDATE pr_tasks SET state='CANCELLED' WHERE definition#>>'{caseV2Definition,caseId}' IN ('beta','gamma')",
        );
        result = (await call('/v2/requests/request-main/report')).json();
        assert.ok(
          validateRequestResultV2(result),
          JSON.stringify(validateRequestResultV2.errors),
        );
        assert.equal(result.reportPhase, 'FINAL');
        assert.equal(result.reportStatus, 'FAILED');
        assert.equal(result.confirmedDisagreementCount, 1);
        assert.equal(result.reportCoverage.missing, 4);
        assert.equal(result.uniqueCriteriaCounts.failed, 1);
        assert.equal(result.uniqueCriteriaCounts.skipped, 2);
        assert.equal(result.cases[1]!.arms[0]!.result.reportStatus, null);
        await sql.query(
          "UPDATE pr_tasks SET archived_at=clock_timestamp() WHERE id='case-v2-alpha'",
        );
        const archived = (
          await call('/v2/requests/request-main/report')
        ).json<RequestResultV2>();
        assert.equal(archived.reportStatus, result.reportStatus);
        assert.ok(archived.cases[0]!.arms[0]!.archivedAt);
      },
    );
    // 范围：请求分页和过滤完整性，含微秒游标绑定；不测试浏览器列表交互。
    await suite.test('列表筛选不截断成员，分页不遗漏或重复请求', async () => {
      const search = await call('/v2/requests?q=beta&reportStatus=FAILED');
      const listed = search.json();
      assert.ok(
        validateRequestList(listed),
        JSON.stringify(validateRequestList.errors),
      );
      assert.equal(listed.requests[0]!.caseCount, 3);
      assert.equal(listed.requests[0]!.reportStatus, 'FAILED');
      await sql.query(
        "UPDATE pr_verification_requests SET created_at='2026-10-19T00:00:00.123456Z'::timestamptz",
      );
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const response = await call(
          `/v2/requests?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        assert.equal(response.statusCode, 200, response.body);
        const page = response.json();
        ids.push(
          ...page.requests.map((r: { requestId: string }) => r.requestId),
        );
        cursor = page.nextCursor;
      } while (cursor);
      assert.equal(ids.length, new Set(ids).size);
      assert.equal(
        ids.length,
        (
          await sql.query(
            'SELECT count(*)::int AS n FROM pr_verification_requests',
          )
        ).rows[0].n,
      );
      const first = (await call('/v2/requests?limit=1')).json();
      assert.equal(
        (
          await call(
            `/v2/requests?q=changed&cursor=${encodeURIComponent(first.nextCursor)}`,
          )
        ).statusCode,
        400,
      );
      for (const query of [
        'limit=0',
        'executionStatus=ERROR',
        'reportStatus=BOGUS',
        'unknown=true',
        'cursor=bad',
      ])
        assert.equal((await call(`/v2/requests?${query}`)).statusCode, 400);
    });
    // 范围：全请求新身份、来源与冲突回滚；没有运行新任务。
    await suite.test(
      '整请求重跑原子创建新成员，重试不重复且拒绝既有目标',
      async () => {
        const body = {
          requestId: 'rerun-request',
          caseIds: ['alpha', 'beta', 'gamma'].map((sourceCaseId) => ({
            sourceCaseId,
            caseId: `rerun-${sourceCaseId}`,
          })),
        };
        const response = await call('/v2/requests/request-main/rerun', body);
        assert.equal(response.statusCode, 202, response.body);
        const result = response.json<RequestResultV2>();
        assert.ok(validateRequestResultV2(result));
        assert.equal(result.sourceRequestId, 'request-main');
        assert.equal(result.executionCounts.total, 6);
        assert.equal(result.cases[0]!.sourceCaseId, 'alpha');
        assert.equal(result.reportStatus, null);
        assert.equal(
          (await call('/v2/requests/request-main/rerun', body)).statusCode,
          202,
        );
        assert.equal(
          (
            await call('/v2/requests/request-main/rerun', {
              ...body,
              budgetMode: 'original',
            })
          ).statusCode,
          409,
        );
        const conflict = {
          requestId: 'bad-rerun',
          caseIds: [
            { sourceCaseId: 'alpha', caseId: 'unused-rerun' },
            { sourceCaseId: 'beta', caseId: 'delta' },
            { sourceCaseId: 'gamma', caseId: 'unused-rerun-two' },
          ],
        };
        assert.equal(
          (await call('/v2/requests/request-main/rerun', conflict)).statusCode,
          409,
        );
        assert.equal((await call('/v2/requests/bad-rerun')).statusCode, 404);
        assert.equal(
          (
            await sql.query(
              "SELECT count(*)::int AS n FROM pr_tasks WHERE id='case-v2-unused-rerun'",
            )
          ).rows[0].n,
          0,
        );
      },
    );
    // 范围：旧数组形状、未归组入口与管理员隔离；不覆盖真实外部凭据管理。
    await suite.test(
      '旧数组仍返回数组且不猜测归属，新入口要求认证',
      async () => {
        const response = await call('/v2/cases', [example('legacy')]);
        assert.equal(response.statusCode, 202);
        assert.ok(Array.isArray(response.json()));
        const list = (await call('/v1/tasks?ungrouped=true')).json();
        assert.deepEqual(
          new Set(list.tasks.map((t: { caseId: string }) => t.caseId)),
          new Set(['legacy']),
        );
        for (const path of [
          '/v2/requests',
          '/v2/requests/request-main',
          '/v2/requests/request-main/report',
          '/v1/tasks/case-v2-alpha/requests',
        ])
          assert.equal((await app.inject({ url: path })).statusCode, 401);
      },
    );
  } finally {
    await app.close();
    await sql.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  }
});
