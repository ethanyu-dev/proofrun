import { seedHistoricalPair } from './historical-comparison.js';
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
        executionMode: 'llm',
        evidenceKinds: ['DOM'],
      },
    },
    { logger: false },
  );
  const call = async (path: string, body?: unknown) => {
    const response = await app.inject({
      method: body === undefined ? 'GET' : 'POST',
      url: path,
      headers: { authorization: `Bearer ${ADMIN}` },
      ...(body === undefined ? {} : { payload: body as object }),
    });
    // 历史聚合夹具显式导入旧双跑记录，新接口本身只产生 LLM。
    if (
      path === '/v2/cases' &&
      response.statusCode === 202 &&
      body &&
      !Array.isArray(body)
    ) {
      const input = body as { requestId: string; cases: VerificationCaseV2[] };
      for (const item of input.cases)
        await seedHistoricalPair(sql, `case-v2-${item.caseId}`);
      const stored = await app.inject({
        method: 'GET',
        url: `/v2/requests/${input.requestId}`,
        headers: { authorization: `Bearer ${ADMIN}` },
      });
      stored.statusCode = 202;
      return stored;
    }
    return response;
  };
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
    await suite.test(
      '历史三个 case 六个执行组，只统计三个唯一验收项',
      async () => {
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
          (await sql.query('SELECT count(*)::int AS n FROM pr_tasks')).rows[0]
            .n,
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
      },
    );
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
    // 范围：管理员与 Worker 的旧分析入口均已退役；注入 HTTP 不验证线上部署版本。
    await suite.test('报告分析接口不再提供服务', async () => {
      for (const [method, url] of [
        ['GET', '/v2/requests/request-main/analysis'],
        ['POST', '/v2/requests/request-main/analysis'],
        ['POST', '/v1/worker/analyses/claim'],
        [
          'GET',
          '/v1/analyses/request-main/context?caseIndex=0&record=0&offset=0',
        ],
        ['POST', '/v1/analyses/request-main/heartbeat'],
        ['POST', '/v1/analyses/request-main/model-calls/fixture'],
        ['POST', '/v1/analyses/request-main/complete'],
      ] as const) {
        for (const token of [ADMIN, 'request-integration-worker-fixture']) {
          const response = await app.inject({
            method,
            url,
            headers: { authorization: `Bearer ${token}` },
            ...(method === 'POST' ? { payload: {} } : {}),
          });
          assert.equal(
            response.statusCode,
            404,
            `${method} ${url}: ${response.body}`,
          );
        }
      }
    });
    // 范围：真实数据库关联、同一 JEV 执行内混合调用拆分及无报告用量；不运行真实模型或计费。
    await suite.test(
      '请求耗时按执行跨度，Tokens 按调用用途拆分且不重复累加报告',
      async () => {
        await sql.query(
          "INSERT INTO pr_executions(id,task_id,worker_id,token_hash,lease_expires_at,state,created_at) VALUES('usage-trace','comparison-case-v2-alpha-jev','fixture','fixture',clock_timestamp(),'FINISHED','2026-10-19T00:00:00Z')",
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
          "INSERT INTO pr_model_calls(id,execution_id,call_index,record,start_hash) VALUES('usage-jev','usage-trace',1,$1,'fixture')",
          [
            JSON.stringify({
              purpose: 'JEV_SELECTION',
              promptTokens: 1000,
              completionTokens: 100,
            }),
          ],
        );
        await sql.query(
          "INSERT INTO pr_model_calls(id,execution_id,call_index,record,start_hash) VALUES('usage-llm','usage-trace',2,$1,'fixture')",
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
        assert.equal(result.metrics.totalTokens, 3300);
        assert.equal('analysis' in result.metrics, false);
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
          "INSERT INTO pr_model_calls(id,execution_id,call_index,record,start_hash) VALUES('usage-error','usage-trace',3,$1,'fixture')",
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
        assert.equal(result.executionCounts.total, 3);
        assert.equal(result.cases[0]!.sourceCaseId, 'alpha');
        assert.equal(result.cases[0]!.caseId, 'alpha');
        assert.equal(result.cases[0]!.arms[0]!.taskId, 'case-run-rerun-alpha');
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
            { sourceCaseId: 'beta', caseId: 'rerun-alpha' },
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
              "SELECT count(*)::int AS n FROM pr_tasks WHERE id='case-run-unused-rerun'",
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
    // 范围：真实数据库与两条 HTTP 读取入口保持同一异常步骤投影；证据和进度由夹具注入，不代表浏览器验收。
    await suite.test(
      'Case 与请求详情保留相同的异常现场和部分结论',
      async () => {
        const input = example('projection-consistency');
        input.steps.push({
          ...input.steps[0]!,
          stepId: 'later',
          exec_order: 2,
        });
        const submitted = await app.inject({
          method: 'POST',
          url: '/v2/cases',
          headers: { authorization: `Bearer ${ADMIN}` },
          payload: { requestId: 'projection-consistency', cases: [input] },
        });
        assert.equal(submitted.statusCode, 202, submitted.body);
        const taskId = 'case-v2-projection-consistency';
        const definition = (
          await sql.query('SELECT definition FROM pr_tasks WHERE id=$1', [
            taskId,
          ])
        ).rows[0].definition;
        const snapshot = definition.steps.map(
          (step: { stepId: string }, index: number) => ({
            stepId: step.stepId,
            groupId: 'group-1',
            phase: 'VERIFYING',
            status: index === 0 ? 'RUNNING' : 'PENDING',
            summary: '夹具已记录的进度',
            evidenceRefs: index === 0 ? ['observed-dom'] : [],
            criteria:
              index === 0
                ? [
                    {
                      criterionId: definition.acceptanceCriteria[0].id,
                      verdict: 'PASSED',
                      summary: '已记录部分结论',
                      evidenceRefs: ['observed-dom'],
                    },
                  ]
                : [],
            startedAt: index === 0 ? new Date().toISOString() : null,
            finishedAt: null,
          }),
        );
        for (const state of ['RUNNING', 'ERROR', 'CANCELLED', 'TIMED_OUT']) {
          await sql.query(
            'UPDATE pr_tasks SET state=$2,step_results=$3 WHERE id=$1',
            [taskId, state, JSON.stringify(snapshot)],
          );
          const direct = await call('/v2/cases/projection-consistency');
          const request = await call('/v2/requests/projection-consistency');
          assert.equal(direct.statusCode, 200, direct.body);
          assert.equal(request.statusCode, 200, request.body);
          assert.ok(
            validateRequestResultV2(request.json()),
            JSON.stringify(validateRequestResultV2.errors),
          );
          const result = direct.json();
          assert.deepEqual(request.json().cases[0].arms[0].result, result);
          assert.equal(
            result.steps[0].status,
            state === 'RUNNING' ? 'RUNNING' : 'ERROR',
          );
          assert.equal(
            result.steps[1].status,
            state === 'RUNNING' ? 'PENDING' : 'SKIPPED',
          );
          assert.deepEqual(result.steps[0].evidenceRefs, ['observed-dom']);
          assert.deepEqual(result.steps[0].criteria, snapshot[0].criteria);
          assert.equal(result.steps[0].groupId, 'group-1');
          assert.equal(result.steps[0].phase, 'VERIFYING');
          assert.equal(result.result, null);
          assert.equal(result.reportStatus, null);
          assert.deepEqual(
            (
              await sql.query('SELECT step_results FROM pr_tasks WHERE id=$1', [
                taskId,
              ])
            ).rows[0].step_results,
            snapshot,
          );
        }
      },
    );
    // 范围：真实数据库中的整体原地重跑、并发幂等、历史保留与共享隔离；不运行浏览器或模型。
    await suite.test('整体重跑保留请求并原子切换全部成员', async () => {
      await submit('in-place', ['in-place-a', 'in-place-b']);
      await submit('in-place-shared', ['in-place-a']);
      const before = (await call('/v2/requests/in-place')).json();
      const shared = (await call('/v2/requests/in-place-shared')).json();
      const body = {
        caseIds: ['in-place-a', 'in-place-b'].map((sourceCaseId) => ({
          sourceCaseId,
          runId: `first-${sourceCaseId}`,
        })),
      };
      // 先建立派生摘要，再检查成员切换使它失效并重算。
      await call('/v2/requests');
      const responses = await Promise.all(
        Array.from({ length: 3 }, () =>
          call('/v2/requests/in-place/rerun', body),
        ),
      );
      for (const response of responses) {
        assert.equal(response.statusCode, 202, response.body);
        const result = response.json<RequestResultV2>();
        assert.ok(validateRequestResultV2(result));
        assert.equal(result.requestId, before.requestId);
        assert.equal(result.createdAt, before.createdAt);
        assert.equal(result.title, before.title);
        assert.equal(result.sourceRequestId, null);
        assert.equal(result.executionCounts.total, 2);
        assert.equal(result.executionStatus, 'QUEUED');
        assert.deepEqual(
          result.cases.map((c) => c.arms.map((a) => a.taskId)),
          [['case-run-first-in-place-a'], ['case-run-first-in-place-b']],
        );
      }
      assert.deepEqual(
        (await call('/v2/requests/in-place-shared')).json().cases,
        shared.cases,
      );
      assert.equal(
        (
          await sql.query(
            "SELECT count(*)::int n FROM pr_verification_requests WHERE request_id LIKE 'in-place%'",
          )
        ).rows[0].n,
        2,
      );
      assert.equal(
        (
          await sql.query(
            "SELECT count(*)::int n FROM pr_tasks WHERE id LIKE 'case-run-first-in-place-%'",
          )
        ).rows[0].n,
        2,
      );
      for (const member of before.cases)
        for (const arm of member.arms)
          assert.equal((await call(`/v1/tasks/${arm.taskId}`)).statusCode, 200);
    });
    // 范围：单成员切换、旧操作重试不倒退、冲突整批回滚与校验；不验证外部执行。
    await suite.test(
      '单 case 重跑不影响其他成员，失败不留下部分运行',
      async () => {
        const path = '/v2/requests/in-place/rerun';
        const single = {
          caseIds: [{ sourceCaseId: 'in-place-a', runId: 'second-in-place-a' }],
        };
        const response = await call(path, single);
        assert.equal(response.statusCode, 202, response.body);
        const current = response.json().cases;
        assert.equal(current[0].arms[0].taskId, 'case-run-second-in-place-a');
        assert.equal(current[1].arms[0].taskId, 'case-run-first-in-place-b');
        const old = await call(path, {
          caseIds: ['in-place-b', 'in-place-a'].map((sourceCaseId) => ({
            sourceCaseId,
            runId: `first-${sourceCaseId}`,
          })),
        });
        assert.equal(old.statusCode, 202, old.body);
        assert.deepEqual(old.json().cases, current);
        assert.equal(
          (
            await call(path, {
              ...single,
              timeBudget: { stepTimeoutMs: 120000 },
            })
          ).statusCode,
          409,
        );
        // 第一项先完成编译，第二项复用已有运行触发事务冲突，不能残留第一项。
        const conflict = await call(path, {
          caseIds: [
            { sourceCaseId: 'in-place-a', runId: 'rollback-in-place-a' },
            { sourceCaseId: 'in-place-b', runId: 'first-in-place-b' },
          ],
        });
        assert.equal(conflict.statusCode, 409, conflict.body);
        assert.equal(
          (
            await sql.query(
              "SELECT count(*)::int n FROM pr_tasks WHERE id='case-run-rollback-in-place-a'",
            )
          ).rows[0].n,
          0,
        );
        assert.deepEqual(
          (await call('/v2/requests/in-place')).json().cases,
          current,
        );
        for (const caseIds of [
          [],
          [single.caseIds[0], single.caseIds[0]],
          [{ sourceCaseId: 'outsider', runId: 'unused' }],
          [
            { sourceCaseId: 'in-place-a', runId: 'duplicate' },
            { sourceCaseId: 'in-place-b', runId: 'duplicate' },
          ],
        ])
          assert.equal((await call(path, { caseIds })).statusCode, 400);
        assert.equal(
          (await app.inject({ method: 'POST', url: path, payload: single }))
            .statusCode,
          401,
        );
      },
    );
    // 范围：重跑沿用请求自身的冻结配置；不运行真实 worker 或浏览器。
    await suite.test('重跑使用请求当前配置', async () => {
      await sql.query(
        "UPDATE pr_tasks SET state='COMPLETED' WHERE id IN ('case-run-second-in-place-a','case-run-first-in-place-b')",
      );
      // 为同一逻辑 case 制造另一份独立运行，冻结环境不同；请求内重跑不得选取它。
      assert.equal(
        (
          await call('/v2/cases/in-place-a/rerun', {
            runId: 'foreign-in-place-a',
          })
        ).statusCode,
        202,
      );
      await sql.query(
        "UPDATE pr_tasks SET definition=jsonb_set(definition,'{environment,id}','\"foreign\"') WHERE id='case-run-foreign-in-place-a'",
      );
      const next = await call('/v2/requests/in-place/rerun', {
        caseIds: [{ sourceCaseId: 'in-place-a', runId: 'third-in-place-a' }],
      });
      assert.equal(next.statusCode, 202, next.body);
      assert.equal(
        (
          await sql.query(
            "SELECT definition#>>'{environment,id}' id FROM pr_tasks WHERE id='case-run-third-in-place-a'",
          )
        ).rows[0].id,
        'fixture',
      );
      await sql.query(
        "UPDATE pr_tasks SET state='COMPLETED' WHERE id='case-run-third-in-place-a'",
      );
    });
    // 范围：报告只采用最新关联运行的结果，历史报告保持可查；报告注入不代表真实验收。
    await suite.test('请求报告显示最新测试结果而非历史结果', async () => {
      const template = (
        await sql.query("SELECT report FROM pr_tasks WHERE id='case-v2-alpha'")
      ).rows[0].report;
      for (const [taskId, summary] of [
        ['case-run-second-in-place-a', '上一轮结果'],
        ['case-run-third-in-place-a', '最新一轮结果'],
      ])
        await sql.query('UPDATE pr_tasks SET report=$2 WHERE id=$1', [
          taskId,
          { ...template, taskId, summary },
        ]);
      const result = (
        await call('/v2/requests/in-place/report')
      ).json<RequestResultV2>();
      assert.ok(validateRequestResultV2(result));
      assert.equal(
        result.cases[0]!.arms[0]!.result.result!.summary,
        '最新一轮结果',
      );
      assert.equal(
        result.cases[1]!.arms[0]!.taskId,
        'case-run-first-in-place-b',
      );
      assert.equal(
        (
          await sql.query(
            "SELECT report->>'summary' summary FROM pr_tasks WHERE id='case-run-second-in-place-a'",
          )
        ).rows[0].summary,
        '上一轮结果',
      );
    });
    // 范围：历史混合请求默认重跑分别判断身份并保留旧记录；数据库与 HTTP 真实，未运行浏览器。
    await suite.test(
      '历史请求无需身份选择即可重跑访客和登录 case',
      async () => {
        await submit('automatic-history', [
          'automatic-guest',
          'automatic-login',
        ]);
        const oldIds = ['case-v2-automatic-guest', 'case-v2-automatic-login'];
        for (const [index, id] of oldIds.entries()) {
          const definition = (
            await sql.query('SELECT definition FROM pr_tasks WHERE id=$1', [id])
          ).rows[0].definition;
          definition.sessionPlan = {
            version: 1,
            mode: 'pool',
            candidates: [],
            requirements: [],
            preparationMs: 120000,
            library: true,
            selection: 'pending',
          };
          definition.caseV2Definition.session = {
            mode: 'pool',
            poolRef: 'retired',
          };
          definition.caseV2Definition.steps[0].exec_order = 2;
          definition.caseV2Definition.steps.unshift({
            ...definition.caseV2Definition.steps[0],
            stepId: 'prepare',
            type: 'setup',
            exec_order: 1,
            expected: [],
            description: index
              ? '使用测试账号登录后检查页面'
              : '保持未登录访客状态',
          });
          definition.environment.auth = {
            nodeId: 'retired',
            stateId: 'retired',
            restore: true,
          };
          definition.environment.allowIntervention = false;
          await sql.query('UPDATE pr_tasks SET definition=$2 WHERE id=$1', [
            id,
            definition,
          ]);
        }
        const before = (
          await sql.query(
            'SELECT id,definition,report FROM pr_tasks WHERE id=ANY($1) ORDER BY id',
            [oldIds],
          )
        ).rows;
        const body = {
          caseIds: ['automatic-guest', 'automatic-login'].map(
            (sourceCaseId) => ({ sourceCaseId, runId: `${sourceCaseId}-new` }),
          ),
        };
        for (const reply of await Promise.all([
          call('/v2/requests/automatic-history/rerun', body),
          call('/v2/requests/automatic-history/rerun', body),
        ]))
          assert.equal(reply.statusCode, 202, reply.body);
        for (const [index, mapping] of body.caseIds.entries()) {
          const current = (
            await sql.query('SELECT definition FROM pr_tasks WHERE id=$1', [
              `case-run-${mapping.runId}`,
            ])
          ).rows[0].definition;
          assert.equal(current.sessionPlan.mode, index ? 'manual' : 'guest');
          assert.equal(current.sessionPlan.automatic.loginRequired, !!index);
          assert.equal(current.environment.auth, undefined);
          assert.equal(current.environment.allowIntervention, true);
          if (index) {
            assert.equal(
              current.sessionPlan.automatic.fallbackReason,
              'DEVPASS_NOT_CONFIGURED',
            );
            assert.equal(current.sessionPlan.requirements.length, 1);
            assert.equal(current.sessionPlan.requirements[0].method, 'manual');
          }
        }
        assert.deepEqual(
          (
            await sql.query(
              'SELECT id,definition,report FROM pr_tasks WHERE id=ANY($1) ORDER BY id',
              [oldIds],
            )
          ).rows,
          before,
        );
        const next = await call('/v2/cases/automatic-login/rerun', {
          runId: 'automatic-login-again',
        });
        assert.equal(next.statusCode, 202, next.body);
        const plan = (
          await sql.query(
            "SELECT definition->'sessionPlan' AS plan FROM pr_tasks WHERE id='case-run-automatic-login-again'",
          )
        ).rows[0].plan;
        assert.equal(
          plan.requirements.length,
          1,
          '再次重跑不继承上一轮临时人工门禁',
        );
      },
    );
    // 范围：真实 PostgreSQL/HTTP 的身份替换、原子失败、并发幂等及历史证据引用保留；不运行真实浏览器或 DevPass。
    await suite.test(
      '历史请求按 case 重配身份并保留历史及共享请求',
      async () => {
        await submit('identity-history', ['identity-a', 'identity-b']);
        await submit('identity-shared', ['identity-a']);
        const shared = (await call('/v2/requests/identity-shared')).json();
        const oldIds = ['case-v2-identity-a', 'case-v2-identity-b'];
        for (const id of oldIds) {
          const row = (
            await sql.query('SELECT definition FROM pr_tasks WHERE id=$1', [id])
          ).rows[0];
          row.definition.sessionPlan = {
            version: 1,
            mode: 'pool',
            candidates: [],
            requirements: [],
            preparationMs: 120000,
            library: true,
            selection: 'pending',
          };
          row.definition.caseV2Definition.session = {
            mode: 'pool',
            poolRef: 'retired',
          };
          row.definition.environment.auth = {
            nodeId: 'retired',
            stateId: 'retired',
            restore: true,
          };
          await sql.query('UPDATE pr_tasks SET definition=$2 WHERE id=$1', [
            id,
            row.definition,
          ]);
        }
        // 报告及证据引用由夹具注入，只验证历史事实保留，不冒充真实浏览器采集。
        const reportTemplate = (
          await sql.query(
            "SELECT report FROM pr_tasks WHERE id='case-v2-alpha'",
          )
        ).rows[0].report;
        const historicalReport = {
          ...reportTemplate,
          taskId: oldIds[0],
          summary: '重配身份前的历史报告',
          artifacts: [
            {
              id: 'identity-history-dom',
              kind: 'DOM',
              uri: 'artifact://identity-history-dom',
              sha256: 'a'.repeat(64),
            },
          ],
        };
        await sql.query('UPDATE pr_tasks SET report=$2 WHERE id=$1', [
          oldIds[0],
          historicalReport,
        ]);
        const historicalView = (
          await call('/v2/cases/identity-a?runId=case-v2-identity-a')
        ).json();
        const old = (
          await sql.query(
            'SELECT id,definition,report,step_results FROM pr_tasks WHERE id=ANY($1) ORDER BY id',
            [oldIds],
          )
        ).rows;
        const path = '/v2/requests/identity-history/rerun';
        const body = {
          caseIds: [
            {
              sourceCaseId: 'identity-a',
              runId: 'identity-new-a',
              session: { mode: 'guest' },
            },
            {
              sourceCaseId: 'identity-b',
              runId: 'identity-new-b',
              session: { mode: 'manual' },
            },
          ],
        };
        const incomplete = structuredClone(body);
        incomplete.caseIds[1]!.sourceCaseId = 'outside-request';
        const rejected = await call(path, incomplete);
        assert.equal(rejected.statusCode, 400, rejected.body);
        assert.equal(rejected.json().code, 'INVALID_RERUN');
        assert.equal(
          (
            await sql.query(
              "SELECT count(*)::int n FROM pr_tasks WHERE id LIKE 'case-run-identity-new-%'",
            )
          ).rows[0].n,
          0,
        );
        const invalid = await call(path, {
          caseIds: [
            {
              sourceCaseId: 'identity-a',
              runId: 'bad-session',
              session: { mode: 'external' },
            },
          ],
        });
        assert.equal(invalid.statusCode, 400, invalid.body);
        const replies = await Promise.all([call(path, body), call(path, body)]);
        for (const reply of replies)
          assert.equal(reply.statusCode, 202, reply.body);
        for (const [index, mapping] of body.caseIds.entries()) {
          const current = (
            await sql.query('SELECT definition FROM pr_tasks WHERE id=$1', [
              `case-run-${mapping.runId}`,
            ])
          ).rows[0].definition;
          assert.equal(current.sessionPlan.mode, mapping.session.mode);
          assert.deepEqual(current.rerunSession, mapping.session);
          assert.equal(current.environment.auth, undefined);
          assert.equal(current.caseV2Definition.caseId, mapping.sourceCaseId);
          assert.deepEqual(
            current.caseV2Definition.steps,
            old[index].definition.caseV2Definition.steps,
          );
        }
        const changed = structuredClone(body);
        changed.caseIds[0]!.session.mode = 'manual';
        assert.equal((await call(path, changed)).statusCode, 409);
        assert.equal(
          (
            await call('/v2/cases/identity-a/rerun', {
              runId: 'identity-new-a',
              session: { mode: 'manual' },
            })
          ).statusCode,
          409,
        );
        const single = await call('/v2/cases/identity-a/rerun', {
          runId: 'identity-single',
          session: { mode: 'manual' },
        });
        assert.equal(single.statusCode, 202, single.body);
        const inherited = await call('/v2/cases/identity-a/rerun', {
          runId: 'identity-inherited',
        });
        assert.equal(inherited.statusCode, 202, inherited.body);
        // 未显式覆盖的新重跑重新判断需求；原步骤不需要登录，因此不会继承上一轮人工会话。
        assert.equal(
          (
            await sql.query(
              "SELECT definition#>>'{sessionPlan,mode}' mode FROM pr_tasks WHERE id='case-run-identity-inherited'",
            )
          ).rows[0].mode,
          'guest',
        );
        assert.deepEqual(
          (
            await sql.query(
              'SELECT id,definition,report,step_results FROM pr_tasks WHERE id=ANY($1) ORDER BY id',
              [oldIds],
            )
          ).rows,
          old,
        );
        const sharedNow = (await call('/v2/requests/identity-shared')).json();
        assert.equal(
          sharedNow.cases[0].arms[0].taskId,
          shared.cases[0].arms[0].taskId,
        );
        assert.equal(
          (await call('/v2/requests/identity-history')).json().cases[0].arms[0]
            .taskId,
          'case-run-identity-new-a',
        );
        const historicalAfter = (
          await call('/v2/cases/identity-a?runId=case-v2-identity-a')
        ).json();
        assert.deepEqual(historicalAfter.result, historicalView.result);
        assert.equal(historicalAfter.result.summary, historicalReport.summary);
        assert.ok(
          historicalAfter.result.evidence.some(
            (item: { id: string }) => item.id === 'identity-history-dom',
          ),
        );
        // 相同最终身份但覆盖意图不同，也必须在并发写入检查中拒绝复用运行 ID。
        const raced = await Promise.all([
          call('/v2/cases/identity-a/rerun', {
            runId: 'identity-race',
            session: { mode: 'manual' },
          }),
          call('/v2/cases/identity-a/rerun', { runId: 'identity-race' }),
        ]);
        assert.deepEqual(
          raced.map((reply) => reply.statusCode).sort(),
          [202, 409],
        );
        const runs = await call('/v2/cases/identity-a/runs');
        assert.equal(runs.statusCode, 200, runs.body);
        assert.ok(runs.body.includes('case-v2-identity-a'));
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
