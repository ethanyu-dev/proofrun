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
  // 夹具只需要顺序查询；Client.end 会等待连接关闭，避免 Pool.end 清空池后删库仍与断连竞争。
  const sql = new pg.Client({ connectionString: url.toString() });
  await sql.connect();
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
    // 范围：真实数据库队列、认证、分片读取、租约恢复和重跑隔离；模型结果为夹具，不代表归因质量。
    await suite.test(
      '报告分析异步生成且不重跑 case，旧领取不能覆盖新结果',
      async () => {
        const path = '/v2/requests/request-main/analysis';
        const workerCall = (
          url: string,
          body: object = {},
          token = 'request-integration-worker-fixture',
          method: 'GET' | 'POST' = 'POST',
        ) =>
          app.inject({
            method,
            url,
            headers: { authorization: `Bearer ${token}` },
            ...(method === 'POST' ? { payload: body } : {}),
          });
        assert.equal(
          (await app.inject({ method: 'POST', url: path, payload: {} }))
            .statusCode,
          401,
        );
        assert.equal(
          (await call('/v2/requests/concurrent/analysis', {})).statusCode,
          409,
        );
        assert.equal((await call(path)).json(), null);
        const before = (
          await sql.query('SELECT count(*)::int AS n FROM pr_tasks')
        ).rows[0].n;
        const enqueued = await Promise.all([call(path, {}), call(path, {})]);
        assert.equal(enqueued[0]!.statusCode, 202, enqueued[0]!.body);
        assert.equal(
          enqueued[0]!.json().revision,
          enqueued[1]!.json().revision,
        );
        const claims = await Promise.all([
          workerCall('/v1/worker/analyses/claim'),
          workerCall('/v1/worker/analyses/claim'),
        ]);
        const grants = claims.map((reply) => reply.json()).filter(Boolean);
        assert.equal(grants.length, 1);
        const grant = grants[0];
        assert.deepEqual(grant.caseIndices, [0, 1, 2]);
        const base = '/v1/analyses/request-main';
        // 用量先登记、后回写；重复交付不能双计，错凭据与非法用量被拒绝。
        const usagePath = `${base}/model-calls/usage-first`;
        const start = { phase: 'start', stage: 'review', model: 'fixture-llm' };
        const finish = {
          phase: 'finish',
          status: 'RECEIVED',
          promptTokens: 100,
          completionTokens: 10,
          elapsedMs: 25,
          error: null,
        };
        assert.equal(
          (await workerCall(usagePath, start, grant.token)).statusCode,
          200,
        );
        assert.equal(
          (await workerCall(usagePath, start, grant.token)).statusCode,
          200,
        );
        assert.equal(
          (await workerCall(usagePath, finish, 'invalid-token')).statusCode,
          409,
        );
        assert.equal(
          (
            await workerCall(
              usagePath,
              { ...finish, promptTokens: -1 },
              grant.token,
            )
          ).statusCode,
          400,
        );
        assert.equal(
          (
            await workerCall(
              usagePath,
              { ...finish, privateData: 'not allowed' },
              grant.token,
            )
          ).statusCode,
          400,
        );
        const getContext = (token: string, record = 0, offset = 0) =>
          workerCall(
            `${base}/context?caseIndex=0&record=${record}&offset=${offset}`,
            {},
            token,
            'GET',
          );
        assert.equal((await getContext('invalid-token')).statusCode, 409);
        const first = await getContext(grant.token);
        assert.equal(first.statusCode, 200, first.body);
        assert.match(first.json().text, /check/);
        assert.match(first.json().text, /FAILED/);
        assert.equal(
          (await workerCall(`${base}/heartbeat`, {}, grant.token)).statusCode,
          200,
        );
        await sql.query(
          "INSERT INTO pr_executions(id,task_id,worker_id,token_hash,lease_expires_at,state) VALUES('analysis-trace','comparison-case-v2-alpha-jev','fixture','fixture',clock_timestamp(),'FINISHED')",
        );
        await sql.query(
          "INSERT INTO pr_model_calls(id,execution_id,call_index,record,start_hash) VALUES('analysis-call','analysis-trace',1,$1,'fixture')",
          [
            {
              stepId: 'check',
              request: JSON.stringify({
                messages: [
                  { role: 'system', content: 'SYSTEM_MUST_NOT_BE_INPUT' },
                  {
                    role: 'user',
                    content:
                      'observation-start-' +
                      'x'.repeat(25000) +
                      '-observation-end',
                  },
                ],
              }),
              response: JSON.stringify({
                choices: [{ message: { content: '实际决策' } }],
              }),
            },
          ],
        );
        const trace = (await getContext(grant.token, 1)).json();
        assert.match(trace.text, /observation-start/);
        assert.doesNotMatch(trace.text, /SYSTEM_MUST_NOT_BE_INPUT/);
        assert.equal(trace.next.record, 1);
        const tail = (
          await getContext(grant.token, trace.next.record, trace.next.offset)
        ).json();
        assert.match(tail.text, /observation-end/);
        assert.match(tail.text, /实际决策/);
        assert.equal((await getContext(grant.token, 2)).json().next, null);
        await sql.query(
          "UPDATE pr_request_analyses SET lease_until=clock_timestamp()-interval '1 second' WHERE request_id='request-main'",
        );
        const recovered = (
          await workerCall('/v1/worker/analyses/claim')
        ).json();
        assert.notEqual(recovered.token, grant.token);
        // 原领取结束后的迟到回执仍只归原调用；不能给新代次派发调用或覆盖总结。
        assert.equal(
          (await workerCall(usagePath, finish, grant.token)).statusCode,
          200,
        );
        assert.equal(
          (await workerCall(usagePath, finish, grant.token)).statusCode,
          200,
        );
        assert.equal(
          (
            await workerCall(
              usagePath,
              { ...finish, promptTokens: 999 },
              grant.token,
            )
          ).statusCode,
          409,
        );
        assert.equal(
          (await workerCall(`${base}/model-calls/stale`, start, grant.token))
            .statusCode,
          409,
        );
        const secondPath = `${base}/model-calls/usage-second`;
        assert.equal(
          (
            await workerCall(
              secondPath,
              { ...start, stage: 'final' },
              recovered.token,
            )
          ).statusCode,
          200,
        );
        assert.equal(
          (
            await workerCall(
              secondPath,
              { ...finish, promptTokens: 200, completionTokens: 20 },
              recovered.token,
            )
          ).statusCode,
          200,
        );

        assert.equal(
          (
            await workerCall(
              `${base}/complete`,
              { summary: '旧结果', model: 'fixture' },
              grant.token,
            )
          ).statusCode,
          409,
        );
        assert.equal(
          (
            await workerCall(
              `${base}/complete`,
              { summary: '失败原因：夹具观察', model: 'fixture' },
              recovered.token,
            )
          ).statusCode,
          200,
        );
        const completed = (await call(path)).json();
        assert.equal(completed.status, 'SUCCEEDED');
        assert.deepEqual(completed.usage.current, {
          promptTokens: 300,
          completionTokens: 30,
          totalTokens: 330,
          calls: 2,
        });
        assert.deepEqual(completed.usage.current, completed.usage.cumulative);

        assert.ok(completed.generatedAt);
        assert.equal(completed.token_hash, undefined);
        assert.equal(
          (await call(path, {})).json().revision,
          completed.revision,
        );
        const rerun = (await call(path, { rerun: true })).json();
        assert.notEqual(rerun.revision, completed.revision);
        assert.equal(rerun.summary, completed.summary);
        const retry = (await workerCall('/v1/worker/analyses/claim')).json();
        assert.equal(rerun.usage.current.totalTokens, null);
        assert.equal(rerun.usage.cumulative.totalTokens, 330);
        const retryPath = `${base}/model-calls/usage-retry`;
        await workerCall(retryPath, start, retry.token);
        await workerCall(
          retryPath,
          { ...finish, promptTokens: 50, completionTokens: 5 },
          retry.token,
        );

        assert.equal(
          (await workerCall(`${base}/complete`, { failed: true }, retry.token))
            .statusCode,
          200,
        );
        assert.equal((await call(path)).json().status, 'FAILED');
        assert.equal((await call(path)).json().summary, completed.summary);
        assert.equal((await call(path)).json().usage.current.totalTokens, 55);
        assert.equal(
          (await call(path)).json().usage.cumulative.totalTokens,
          385,
        );
        const metrics = (await call('/v2/requests/request-main/report')).json()
          .metrics;
        assert.equal(metrics.analysis.totalTokens, 385);

        assert.equal(
          (await sql.query('SELECT count(*)::int AS n FROM pr_tasks')).rows[0]
            .n,
          before,
        );
        await call(path, { rerun: true });
        await workerCall('/v1/worker/analyses/claim');
        await sql.query(
          "UPDATE pr_request_analyses SET attempts=3,lease_until=clock_timestamp()-interval '1 second' WHERE request_id='request-main'",
        );
        assert.equal(
          (await workerCall('/v1/worker/analyses/claim')).json(),
          null,
        );
        assert.equal((await call(path)).json().status, 'FAILED');
      },
    );
    // 范围：真实数据库关联、同一 JEV 执行内混合调用拆分及无报告用量；不运行真实模型或计费。
    await suite.test(
      '请求耗时按执行跨度，Tokens 按调用用途拆分且不重复累加报告',
      async () => {
        await sql.query(
          "UPDATE pr_executions SET created_at='2026-10-19T00:00:00Z' WHERE id='analysis-trace'",
        );
        await sql.query(
          "UPDATE pr_tasks SET finished_at='2026-10-19T00:05:00Z',report=jsonb_set(report,'{executionDetails}',$1) WHERE id='comparison-case-v2-alpha-jev'",
          [
            JSON.stringify({
              model: 'JEV + llm',
              promptTokens: 9999,
              completionTokens: 9999,
              modelCalls: 2,
              elapsedMs: 1000,
              reasonCode: null,
              actions: 0,
              commandIds: [],
            }),
          ],
        );
        await sql.query(
          "UPDATE pr_model_calls SET record=record || $1::jsonb WHERE id='analysis-call'",
          [
            JSON.stringify({
              purpose: 'JEV_SELECTION',
              promptTokens: 1000,
              completionTokens: 100,
            }),
          ],
        );
        await sql.query(
          "INSERT INTO pr_model_calls(id,execution_id,call_index,record,start_hash) VALUES('usage-llm','analysis-trace',2,$1,'fixture')",
          [
            JSON.stringify({
              purpose: 'FIELD_VALUE',
              promptTokens: 2000,
              completionTokens: 200,
            }),
          ],
        );
        const result = (await call('/v2/requests/request-main/report')).json();
        assert.ok(
          validateRequestResultV2(result),
          JSON.stringify(validateRequestResultV2.errors),
        );
        assert.ok(result.metrics);
        assert.equal(result.metrics.executionElapsedMs, 300000);
        assert.equal(result.metrics.jev.totalTokens, 1100);
        assert.equal(result.metrics.llm.totalTokens, 2200);
        assert.equal(result.metrics.execution.totalTokens, 3300);
        assert.equal(result.metrics.totalTokens, 3685);
        assert.equal(result.metrics.execution.calls, 2);
        // 第二组与首组重叠，整体验证为六分钟，既不是耗时相加，也不是取最长单组。
        await sql.query(
          "INSERT INTO pr_executions(id,task_id,worker_id,token_hash,lease_expires_at,state,created_at) VALUES('usage-parallel','case-v2-alpha','fixture','fixture',clock_timestamp(),'FINISHED','2026-10-19T00:02:00Z')",
        );
        await sql.query(
          "UPDATE pr_tasks SET finished_at='2026-10-19T00:06:00Z' WHERE id='case-v2-alpha'",
        );
        assert.equal(
          (await call('/v2/requests/request-main/report')).json().metrics
            .executionElapsedMs,
          360000,
        );
        // 供应商没有返回 usage 的错误调用只增加调用数，不产生虚构 Tokens。
        await sql.query(
          "INSERT INTO pr_model_calls(id,execution_id,call_index,record,start_hash) VALUES('usage-error','analysis-trace',3,$1,'fixture')",
          [
            JSON.stringify({
              purpose: 'DECISION',
              status: 'ERROR',
              promptTokens: null,
              completionTokens: null,
            }),
          ],
        );
        const withError = (
          await call('/v2/requests/request-main/report')
        ).json().metrics;
        assert.equal(withError.execution.totalTokens, 3300);
        assert.equal(withError.execution.calls, 3);

        // 终态缺少最终报告时，逐次调用仍保留；不会把用量变成零。
        const saved = (
          await sql.query(
            "SELECT report FROM pr_tasks WHERE id='comparison-case-v2-alpha-jev'",
          )
        ).rows[0].report;
        await sql.query(
          "UPDATE pr_tasks SET report=NULL WHERE id='comparison-case-v2-alpha-jev'",
        );
        assert.equal(
          (await call('/v2/requests/request-main/report')).json().metrics
            .execution.totalTokens,
          3300,
        );
        await sql.query(
          "UPDATE pr_tasks SET report=$1 WHERE id='comparison-case-v2-alpha-jev'",
          [saved],
        );
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
    // 范围：真实数据库与 HTTP 验证分析范围、全成功直出、幂等及重跑；报告为注入夹具，不证明浏览器验收或模型输出质量。
    await suite.test(
      '只领取异常 case，全成功无需 worker 或模型即可生成固定结论',
      async () => {
        const cases = ['success', 'failure', 'partial', 'unknown'].map(
          (status) => {
            const value = example(`analysis-${status}`);
            value.steps[0]!.expected = ['显示结果', '显示详情'];
            return value;
          },
        );
        const submitted = await call('/v2/cases', {
          requestId: 'analysis-mixed',
          cases,
        });
        assert.equal(submitted.statusCode, 202, submitted.body);
        const snapshot = submitted.json<RequestResultV2>();
        for (const [index, member] of snapshot.cases.entries()) {
          for (const arm of member.arms) {
            // 成功 case 的另一执行组故意失败，确保分析范围与页面一样只采用 JEV。
            const verdicts =
              index === 0
                ? arm.executionMode === 'jev'
                  ? ['PASSED', 'PASSED']
                  : ['FAILED', 'FAILED']
                : index === 1
                  ? ['FAILED', 'FAILED']
                  : index === 2
                    ? ['PASSED', 'FAILED']
                    : ['PASSED', 'INCONCLUSIVE'];
            const report = {
              protocolVersion: '0.1',
              taskId: arm.taskId,
              executionDisposition: index === 3 ? 'BLOCKED' : 'EXECUTED',
              verdict:
                index === 3
                  ? null
                  : verdicts.includes('FAILED')
                    ? 'FAILED'
                    : 'PASSED',
              summary: '分析范围夹具',
              criteria: member.criteria.map((criterion, i) => ({
                criterionId: criterion.criterionId,
                verdict: verdicts[i],
                summary: '夹具观察',
                evidenceRefs: [],
              })),
              artifacts: [],
              steps: [],
            };
            await sql.query(
              "UPDATE pr_tasks SET state='COMPLETED',report=$2,finished_at=clock_timestamp() WHERE id=$1",
              [arm.taskId, report],
            );
          }
        }
        const workerCall = (
          url: string,
          body: object = {},
          token = 'request-integration-worker-fixture',
          method: 'POST' | 'GET' = 'POST',
        ) =>
          app.inject({
            method,
            url,
            headers: { authorization: `Bearer ${token}` },
            ...(method === 'POST' ? { payload: body } : {}),
          });
        const queued = await call('/v2/requests/analysis-mixed/analysis', {});
        assert.equal(queued.json().status, 'QUEUED', queued.body);
        const grant = (await workerCall('/v1/worker/analyses/claim')).json();
        assert.equal(grant.requestId, 'analysis-mixed');
        assert.equal(grant.caseCount, 4);
        assert.deepEqual(grant.caseIndices, [1, 2, 3]);
        for (const [index, status] of [
          [1, 'failure'],
          [2, 'partial'],
          [3, 'unknown'],
        ] as const) {
          const page = await workerCall(
            `/v1/analyses/analysis-mixed/context?caseIndex=${index}&record=0&offset=0`,
            {},
            grant.token,
            'GET',
          );
          assert.equal(page.statusCode, 200, page.body);
          const data = JSON.parse(page.json().text);
          assert.equal(data.verification.status, status);
          assert.equal(data.overall.success, 1);
          assert.equal(data.case.arms.length, 1);
          assert.equal(data.case.arms[0].executionMode, 'jev');
          // 部分失败仍提供已通过项的上下文，不能在复盘前裁掉可能相关的前置事实。
          assert.equal(data.case.arms[0].result.result.criteria.length, 2);
        }
        assert.equal(
          (
            await workerCall(
              '/v1/analyses/analysis-mixed/complete',
              { summary: '异常分析夹具', model: 'fixture' },
              grant.token,
            )
          ).statusCode,
          200,
        );

        const successRequest = await call('/v2/cases', {
          requestId: 'analysis-success-only',
          cases: [cases[0]],
        });
        assert.equal(successRequest.statusCode, 202, successRequest.body);
        const path = '/v2/requests/analysis-success-only/analysis';
        const generated = await Promise.all([call(path, {}), call(path, {})]);
        const result = generated[0]!.json();
        assert.equal(result.status, 'SUCCEEDED', generated[0]!.body);
        assert.equal(result.summary, '本次验证共 1 个 case，全部通过。');
        assert.equal(result.model, null);
        assert.ok(result.generatedAt);
        assert.equal(result.usage.current.calls, 0);
        assert.equal(result.revision, generated[1]!.json().revision);
        assert.equal((await call(path, {})).json().revision, result.revision);
        assert.equal(
          (await workerCall('/v1/worker/analyses/claim')).json(),
          null,
        );
        // 重跑替换旧模型总结时不继续显示旧模型名，也不复用旧代次。
        await sql.query(
          "UPDATE pr_request_analyses SET summary='旧模型总结',model='old-model' WHERE request_id='analysis-success-only'",
        );
        const rerun = (await call(path, { rerun: true })).json();
        assert.notEqual(rerun.revision, result.revision);
        assert.equal(rerun.status, 'SUCCEEDED');
        assert.equal(rerun.summary, result.summary);
        assert.equal(rerun.model, null);
        assert.equal(rerun.usage.current.calls, 0);
        // 升级前已经入队的全成功报告也不派发模型任务。
        await sql.query(
          "UPDATE pr_request_analyses SET status='QUEUED',summary=NULL,generated_at=NULL WHERE request_id='analysis-success-only'",
        );
        assert.equal(
          (await workerCall('/v1/worker/analyses/claim')).json(),
          null,
        );
        const recovered = (await call(path)).json();
        assert.equal(recovered.status, 'SUCCEEDED');
        assert.equal(recovered.summary, result.summary);
        assert.equal(recovered.usage.cumulative.calls, 0);
      },
    );
    // 范围：真实 HTTP 创建、共享、原子重跑后的全部摘要字段与详情一致；不代表真实模型判定准确性。
    await suite.test(
      '所有已提交及重跑请求的列表摘要与详情逐字段一致',
      async () => {
        const list = await call('/v2/requests?limit=100');
        assert.equal(list.statusCode, 200, list.body);
        for (const item of list.json().requests) {
          const detail = (await call(`/v2/requests/${item.requestId}`)).json();
          for (const key of Object.keys(item))
            if (key !== 'generatedAt')
              assert.deepEqual(
                item[key],
                detail[key],
                `${item.requestId}.${key}`,
              );
        }
      },
    );
  } finally {
    await app.close();
    await sql.end();
    // 普通删库让残留连接暴露为测试失败，不能强制断连掩盖资源未释放。
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  }
});
