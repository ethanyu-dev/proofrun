import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import {
  dashboardRange,
  dashboardToday,
  shiftDashboardDate,
  validDashboardDate,
  requestCaseVerification,
  type DashboardStatistics,
  type RequestList,
  type RequestResultV2,
} from '@proofrun/contracts';
import { buildApp } from '../src/app.js';
import { task } from './fixture.js';

/** 仅用于隔离数据库的 HTTP 鉴权，不能作为部署凭据。 */
const ADMIN = 'dashboard-test-admin-fixture';
/** 接入独立 PostgreSQL，每个集成测试自行创建并删除临时数据库。 */
const DATABASE_URL = process.env.PROOFRUN_TEST_DATABASE_URL;

// 范围：北京时间、自然周、闰月及月末切换；不涉及真实数据库或浏览器。
test('统计周期使用北京时间和真实日历边界', () => {
  assert.equal(dashboardToday(new Date('2024-02-29T16:00:00Z')), '2024-03-01');
  assert.equal(validDashboardDate('2023-02-29'), false);
  assert.equal(validDashboardDate('2024-02-30'), false);
  assert.equal(validDashboardDate('2024-2-01'), false);
  assert.equal(dashboardRange('month', '2024-02-29').days.length, 29);
  assert.deepEqual(dashboardRange('week', '2025-01-01').days, [
    '2024-12-30',
    '2024-12-31',
    '2025-01-01',
    '2025-01-02',
    '2025-01-03',
    '2025-01-04',
    '2025-01-05',
  ]);
  assert.equal(
    dashboardRange('day', '2024-03-01').from,
    '2024-03-01T00:00:00+08:00',
  );
  assert.equal(shiftDashboardDate('month', '2024-03-31', -1), '2024-02-01');
  assert.equal(shiftDashboardDate('week', '2025-01-01', -1), '2024-12-23');
});

// 范围：真实迁移、SQL 聚合、HTTP 鉴权和快照投影；记录直接注入，不代表真实模型或业务验收。
test(
  '看板请求归属、当前运行选择和 Tokens 完整性',
  { timeout: 60_000 },
  async (suite) => {
    assert.ok(
      DATABASE_URL,
      '请设置独立测试 PostgreSQL 的 PROOFRUN_TEST_DATABASE_URL',
    );
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    const name = `proofrun_dashboard_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DATABASE_URL);
    url.pathname = `/${name}`;
    const directory = await mkdtemp(join(tmpdir(), 'proofrun-dashboard-'));
    const sql = new pg.Client({ connectionString: url.toString() });
    await sql.connect();
    const app = await buildApp(
      {
        databaseUrl: url.toString(),
        adminToken: ADMIN,
        workerToken: 'dashboard-test-worker-fixture',
        publicUrl: 'http://localhost',
        artifactDirectory: directory,
        host: '127.0.0.1',
        port: 0,
        workerLeaseMs: 15000,
        nodeLeaseMs: 20000,
        tickMs: 1000,
      },
      { logger: false },
    );
    const get = (params: string) =>
      app.inject({
        url: `/v1/admin/statistics?${params}`,
        headers: { authorization: `Bearer ${ADMIN}` },
      });
    const read = async (period: string, date: string) => {
      const response = await get(`period=${period}&date=${date}`);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['cache-control'], 'no-store');
      return response.json<DashboardStatistics>();
    };
    /** 最小报告与任务写入真实数据库，保留两类状态和首次提交时间供聚合断言。 */
    const insertTask = async (
      id: string,
      at: string,
      verdict: string | null,
      extra: Record<string, unknown> = {},
      state = 'COMPLETED',
      details?: object,
      linked = true,
    ) => {
      const definition = { ...task('dashboard-fixture'), taskId: id, ...extra };
      const report = verdict
        ? {
            executionDisposition: 'EXECUTED',
            verdict,
            criteria: [{ criterionId: 'visible', verdict }],
            ...(details
              ? { executionDetails: { model: 'fixture', ...details } }
              : {}),
          }
        : null;
      await sql.query(
        `INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at,created_at,finished_at,report) VALUES($1,$2,'fixture',$3,'2099-01-01',$4,$5,$6)`,
        [id, definition, state, at, state === 'QUEUED' ? null : at, report],
      );
      if (linked && !extra.comparison && extra.purpose !== 'cleanup') {
        await sql.query(
          `INSERT INTO pr_verification_requests(request_id,title,definition_hash,created_at) VALUES($1,$1,'fixture',$2)`,
          [id, at],
        );
        await sql.query(
          `INSERT INTO pr_verification_request_cases(request_id,case_id,task_id,position,definition_hash,execution_origin) VALUES($1,$1,$1,0,'fixture','created')`,
          [id],
        );
      }
    };
    /** 调用时间使用服务端列；刻意设置不同的客户端时间，防止错误读取模型时间。 */
    const insertCall = async (
      taskId: string,
      id: string,
      at: string,
      prompt: number | null,
      completion: number | null,
    ) => {
      await sql.query(
        `INSERT INTO pr_executions(id,task_id,worker_id,token_hash,lease_expires_at,state) VALUES($1,$1,'fixture','fixture','2099-01-01','FINISHED') ON CONFLICT DO NOTHING`,
        [taskId],
      );
      await sql.query(
        `INSERT INTO pr_model_calls(id,execution_id,call_index,record,start_hash,created_at) VALUES($1,$2,(SELECT count(*)+1 FROM pr_model_calls WHERE execution_id=$2),$3,'fixture',$4)`,
        [
          id,
          taskId,
          {
            promptTokens: prompt,
            completionTokens: completion,
            startedAt: '2020-01-01T00:00:00Z',
          },
          at,
        ],
      );
    };
    try {
      // 范围：空周期补日、零分母和拒绝非法参数；不验证外部代理鉴权。
      await suite.test('空周期与输入边界', async () => {
        const unauthorized = await app.inject({ url: '/v1/admin/statistics' });
        assert.equal(unauthorized.statusCode, 401);
        for (const params of [
          'period=year',
          'date=2024-02-30',
          'date=2099-01-01',
          'period=day&period=week',
          'date=2024-03-01&limit=1',
        ])
          assert.equal((await get(params)).statusCode, 400, params);
        const empty = await read('month', '2024-02-01');
        assert.equal(empty.days.length, 29);
        assert.equal(empty.summary.cases.total, 0);
        assert.equal(empty.summary.cases.passRate, null);
        assert.equal(empty.summary.tokens.calls, 0);
        assert.equal(empty.summary.tokens.totalTokens, null);
      });

      await insertTask('before-midnight', '2024-03-03T15:59:59.999Z', 'PASSED');
      await insertTask('llm-arm', '2024-03-03T16:00:00Z', 'FAILED', {
        comparison: { id: 'pair', arm: 'llm' },
      });
      await insertTask(
        'jev-arm',
        '2024-03-03T16:00:00.010Z',
        'PASSED',
        { comparison: { id: 'pair', arm: 'jev' } },
        'COMPLETED',
        { modelCalls: 1, promptTokens: 9999, completionTokens: 9999 },
      );
      await insertTask(
        'unknown',
        '2024-03-04T01:00:00Z',
        null,
        {},
        'CANCELLED',
      );
      await insertTask('queued', '2024-03-04T02:00:00Z', null, {}, 'QUEUED');
      await insertTask('cleanup', '2024-03-04T03:00:00Z', 'PASSED', {
        purpose: 'cleanup',
      });
      await insertTask('rerun-new-identity', '2024-03-05T00:00:00Z', 'FAILED');
      await insertTask('end-excluded', '2024-03-10T16:00:00Z', 'PASSED');
      // 请求内 Case 按展示行计数；同一组实际执行及用量只计一次。
      for (const id of ['request-one', 'request-two']) {
        await sql.query(
          `INSERT INTO pr_verification_requests(request_id,title,definition_hash,created_at) VALUES($1,'统计夹具','fixture','2024-03-04T01:00:00Z')`,
          [id],
        );
        await sql.query(
          `INSERT INTO pr_verification_request_cases(request_id,case_id,task_id,position,definition_hash,execution_origin) VALUES($1,'shared-case','llm-arm',0,'fixture','reused')`,
          [id],
        );
        await sql.query(
          `INSERT INTO pr_verification_request_arms(request_id,case_id,execution_mode,task_id) VALUES($1,'shared-case','jev','jev-arm')`,
          [id],
        );
      }

      // 范围：JEV 展示组、请求成员计数、北京时间闭开区间；不验证 Agent 判定真实性。
      await suite.test(
        'Case 结果按请求创建日分组，周期通过率按分母加权',
        async () => {
          const week = await read('week', '2024-03-06');
          assert.equal(week.startDate, '2024-03-04');
          assert.equal(week.endDate, '2024-03-10');
          assert.deepEqual(week.summary.cases, {
            total: 5,
            finished: 4,
            passed: 2,
            failed: 1,
            inconclusive: 1,
            pending: 1,
            passRate: 1 / 2,
          });
          assert.equal(week.days[0]!.cases.passRate, 2 / 3);
          assert.equal(week.summary.runs, 4);
          assert.equal(week.days[1]!.cases.passRate, 0);
          assert.equal(week.days[2]!.cases.passRate, null);
          assert.equal(
            (await read('day', '2024-03-03')).summary.cases.total,
            1,
          );
        },
      );

      await sql.query(
        `INSERT INTO pr_case_cleanups(parent_task_id,task_id,definition,state) VALUES('jev-arm','cleanup','{}','SKIPPED')`,
      );

      await insertCall(
        'before-midnight',
        'before-call',
        '2024-03-03T15:59:59.999Z',
        500,
        50,
      );
      await insertCall('jev-arm', 'jev-call', '2024-03-03T16:00:00Z', 100, 20);
      await insertCall('llm-arm', 'llm-call', '2024-03-04T01:00:00Z', 200, 40);
      await insertCall('jev-arm', 'jev-retry', '2024-03-04T02:00:00Z', null, 5);
      await insertCall(
        'jev-arm',
        'jev-pending',
        '2024-03-04T03:00:00Z',
        null,
        null,
      );
      await insertCall(
        'cleanup',
        'cleanup-call',
        '2024-03-05T00:00:00Z',
        10,
        2,
      );
      await insertCall(
        'end-excluded',
        'excluded-call',
        '2024-03-10T16:00:00Z',
        500,
        50,
      );
      await insertTask(
        'legacy-report',
        '2024-03-06T00:00:00Z',
        'PASSED',
        {},
        'COMPLETED',
        { modelCalls: 2, promptTokens: 30, completionTokens: 3 },
      );
      // 范围：执行组、跨日、重试、缺失用量及旧报告回填；不推断供应商计费。
      await suite.test(
        'Tokens 不随 Case 复用或报告汇总重复，缺失单独计数',
        async () => {
          const week = await read('week', '2024-03-06');
          assert.deepEqual(week.summary.execution, {
            promptTokens: 340,
            completionTokens: 70,
            totalTokens: 410,
            calls: 7,
            unmeasuredCalls: 2,
          });
          assert.equal('analysis' in week.summary, false);
          assert.equal(week.summary.tokens.totalTokens, 410);
          assert.equal(week.summary.legacyUsageTasks, 1);
          assert.equal(week.days[0]!.tokens.totalTokens, 365);
          assert.equal(week.days[1]!.tokens.totalTokens, 12);
          assert.equal(week.days[2]!.tokens.totalTokens, 33);
          assert.equal(
            week.summary.tokens.totalTokens,
            week.days.reduce(
              (sum, day) => sum + (day.tokens.totalTokens ?? 0),
              0,
            ),
          );
          // 归档只删除正文，累计用量和 Case 结论必须保持。
          await sql.query(
            `UPDATE pr_model_calls SET record=record || '{"request":null,"response":null,"archived":true}'::jsonb`,
          );
          assert.deepEqual(
            (await read('week', '2024-03-06')).summary,
            week.summary,
          );
        },
      );

      // 范围：HTTP 列表与看板逐项对账、历史任务隔离、请求日期和运行切换；报告为注入夹具，不代表生产验收。
      await suite.test(
        '看板与日期筛选后的任务页一致，独立重跑不改变请求结果',
        async () => {
          const api = async <T>(path: string): Promise<T> => {
            const response = await app.inject({
              url: path,
              headers: { authorization: `Bearer ${ADMIN}` },
            });
            assert.equal(response.statusCode, 200, `${path}: ${response.body}`);
            return response.json<T>();
          };
          const listPath =
            '/v2/requests?startDate=2024-03-04&endDate=2024-03-10';
          /** 从任务页实际使用的详情和展示判定独立汇总，避免用看板 SQL 验证自身。 */
          const reconcile = async () => {
            const list = await api<RequestList>(listPath);
            const counts = {
              total: 0,
              finished: 0,
              passed: 0,
              failed: 0,
              inconclusive: 0,
              pending: 0,
              passRate: null as number | null,
            };
            for (const request of list.requests) {
              const detail = await api<RequestResultV2>(
                `/v2/requests/${request.requestId}`,
              );
              for (const member of detail.cases) {
                counts.total++;
                const { status } = requestCaseVerification(member);
                if (status === 'pending') counts.pending++;
                else {
                  counts.finished++;
                  if (status === 'success') counts.passed++;
                  else if (status === 'failure' || status === 'partial')
                    counts.failed++;
                  else counts.inconclusive++;
                }
              }
            }
            counts.passRate = counts.finished
              ? counts.passed / counts.finished
              : null;
            const stats = await read('week', '2024-03-06');
            assert.deepEqual(stats.summary.cases, counts);
            return stats.summary;
          };
          const before = await reconcile();
          await insertTask(
            'unlinked-history',
            '2024-03-06T00:00:00Z',
            'PASSED',
            {},
            'COMPLETED',
            { modelCalls: 1, promptTokens: 900, completionTokens: 90 },
            false,
          );
          await insertTask(
            'independent-rerun',
            '2024-03-06T01:00:00Z',
            'FAILED',
            { caseV2Definition: { caseId: 'shared-case' } },
            'COMPLETED',
            undefined,
            false,
          );
          await sql.query(
            `UPDATE pr_tasks SET definition=definition || '{"caseV2Definition":{"caseId":"shared-case"}}' WHERE id IN ('llm-arm','jev-arm')`,
          );
          assert.deepEqual(await reconcile(), before);

          // 新请求可以复用周期外的运行：Case 按请求创建日计，运行和调用仍按自身日期计。
          await sql.query(
            `INSERT INTO pr_verification_requests(request_id,title,definition_hash,created_at) VALUES('reuse-old','复用旧运行','fixture','2024-03-04T00:00:00+08:00')`,
          );
          await sql.query(
            `INSERT INTO pr_verification_request_cases(request_id,case_id,task_id,position,definition_hash,execution_origin) VALUES('reuse-old','old','before-midnight',0,'fixture','reused')`,
          );
          const reused = await reconcile();
          assert.equal(reused.cases.total, before.cases.total + 1);
          assert.equal(reused.runs, before.runs);
          assert.deepEqual(reused.tokens, before.tokens);

          // 只切换一个请求，另一个共享请求保留旧 JEV 结果；更新请求不改创建日。
          await sql.query(
            `DELETE FROM pr_verification_request_arms WHERE request_id='request-two'`,
          );
          await sql.query(
            `UPDATE pr_verification_request_cases SET task_id='independent-rerun' WHERE request_id='request-two'`,
          );
          const switched = await reconcile();
          assert.equal(switched.cases.total, reused.cases.total);
          assert.equal(switched.cases.passed, reused.cases.passed - 1);
          assert.equal(switched.cases.failed, reused.cases.failed + 1);
          assert.equal(switched.runs, reused.runs + 1);
          const requestOne = await api<RequestResultV2>(
            '/v2/requests/request-one',
          );
          assert.equal(
            requestCaseVerification(requestOne.cases[0]!).status,
            'success',
          );

          // 删除请求即排除其成员及失去引用的执行用量，原任务仍留存。
          await sql.query(
            `UPDATE pr_verification_requests SET deleted_at=clock_timestamp() WHERE request_id='request-one'`,
          );
          const removed = await reconcile();
          assert.equal(removed.cases.total, switched.cases.total - 1);
          assert.equal(removed.runs, switched.runs - 1);
          assert.equal(
            removed.tokens.totalTokens,
            switched.tokens.totalTokens! - 377,
          );

          const page = await api<RequestList>(`${listPath}&limit=1`);
          assert.ok(page.nextCursor);
          for (const suffix of [
            'startDate=2024-03-04',
            'startDate=2024-02-30&endDate=2024-03-10',
            'startDate=2024-03-10&endDate=2024-03-04',
            'startDate=&endDate=',
          ]) {
            const invalid = await app.inject({
              url: `/v2/requests?${suffix}`,
              headers: { authorization: `Bearer ${ADMIN}` },
            });
            assert.equal(invalid.statusCode, 400);
          }
          const changedRange = await app.inject({
            url: `/v2/requests?startDate=2024-03-05&endDate=2024-03-10&cursor=${encodeURIComponent(page.nextCursor!)}`,
            headers: { authorization: `Bearer ${ADMIN}` },
          });
          assert.equal(changedRange.statusCode, 400);
          const next = await api<RequestList>(
            `${listPath}&limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`,
          );
          assert.notEqual(
            next.requests[0]!.requestId,
            page.requests[0]!.requestId,
          );
          // 异常终止时的步骤结论与任务页保持一致；缺最终报告时部分通过不能成为整体通过。
          await insertTask(
            'step-failure',
            '2024-03-06T03:00:00Z',
            null,
            { steps: [{ stepId: 'check' }] },
            'ERROR',
          );
          await sql.query(
            `UPDATE pr_tasks SET step_results=$1 WHERE id='step-failure'`,
            [
              JSON.stringify([
                {
                  stepId: 'check',
                  status: 'ERROR',
                  criteria: [{ criterionId: 'visible', verdict: 'FAILED' }],
                },
              ]),
            ],
          );
          const stepFailure = await reconcile();
          assert.equal(stepFailure.cases.failed, removed.cases.failed + 1);
          await sql.query(
            `UPDATE pr_tasks SET step_results=$1 WHERE id='step-failure'`,
            [
              JSON.stringify([
                {
                  stepId: 'check',
                  status: 'COMPLETED',
                  criteria: [{ criterionId: 'visible', verdict: 'PASSED' }],
                },
              ]),
            ],
          );
          const noReport = await reconcile();
          assert.equal(noReport.cases.passed, removed.cases.passed);
          assert.equal(
            noReport.cases.inconclusive,
            removed.cases.inconclusive + 1,
          );
        },
      );
    } finally {
      await app.close();
      await sql.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
