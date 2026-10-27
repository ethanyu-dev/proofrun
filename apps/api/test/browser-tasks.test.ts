import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {
  validateVerificationTask,
  validateVerificationReport,
  validateTaskList,
  summarizeReport,
  type VerificationReport,
} from '@proofrun/contracts';
import { buildApp } from '../src/app.js';
import { browserTask } from '../src/modules/tasks/browser-task.js';
import { ArtifactStore } from '../src/modules/reports/artifacts.js';
import type { ApiConfig } from '../src/config.js';
import type { Database } from '../src/db.js';
import type { ExecutionContext } from '../src/modules/scheduling/state.js';

/** 测试凭据只用于本地注入接口，不接入真实执行节点。 */
const ADMIN = 'browser-task-admin-fixture-only';
const INPUT = {
  taskId: 'browser-fixture',
  url: 'https://example.test',
  objective: '查询套餐价格并返回表格',
};

// 范围：共享结构校验与类型隔离；不验证真实模型、网页内容或数据库。
test('浏览器任务允许空验收项，历史验证仍要求验收标准', () => {
  const task = browserTask(INPUT, {} as ApiConfig);
  assert.equal(
    validateVerificationTask(task),
    true,
    JSON.stringify(validateVerificationTask.errors),
  );
  const { taskKind: _, ...legacy } = task;
  assert.equal(validateVerificationTask(legacy), false);
  assert.equal(
    validateVerificationTask({ ...task, caseV2Definition: {} }),
    false,
  );
  assert.equal(
    validateVerificationTask({
      ...task,
      acceptanceCriteria: [
        {
          id: 'x',
          description: 'x',
          expectedResult: 'x',
          evidenceKinds: ['DOM'],
        },
      ],
    }),
    false,
  );
  assert.equal(task.environment.allowIntervention, true);
});

// 范围：服务端完成校验、证据归属和报告投影；数据库证据由夹具提供，不证明业务目标实际完成。
test('浏览器完成结果必须有正文和当前执行证据，不能绕过验证报告校验', async () => {
  const task = browserTask(INPUT, {} as ApiConfig);
  const store = new ArtifactStore(
    {} as Database,
    '/unused',
    'http://localhost',
  );
  const sql = {
    async query() {
      return { rows: [{ id: 'evidence', kind: 'DOM', hash: 'a'.repeat(64) }] };
    },
  } as unknown as pg.PoolClient;
  const context = {
    id: 'execution',
    task_id: task.taskId,
    task_state: 'RUNNING',
    definition: task,
  } as ExecutionContext;
  const report: VerificationReport = {
    protocolVersion: '0.1',
    taskId: task.taskId,
    lifecycle: 'COMPLETED',
    executionDisposition: 'EXECUTED',
    verdict: null,
    summary: '| 套餐 | 价格 |\n| -- | -- |\n| 基础 | 10 |',
    criteria: [],
    artifacts: [
      {
        id: 'evidence',
        kind: 'DOM',
        uri: 'http://localhost/evidence',
        sha256: 'a'.repeat(64),
      },
    ],
    browserResult: {
      outcome: 'COMPLETED',
      output: '| 套餐 | 价格 |\n| -- | -- |\n| 基础 | 10 |',
      evidenceRefs: ['evidence'],
    },
  };
  assert.equal(
    validateVerificationReport(report),
    true,
    JSON.stringify(validateVerificationReport.errors),
  );
  assert.deepEqual(summarizeReport(report, [], task), {
    reportStatus: null,
    criteriaCounts: null,
  });
  assert.equal(
    (await store.validateReport(sql, context, report)).verdict,
    null,
  );
  for (const invalid of [
    { ...report, verdict: 'PASSED' },
    { ...report, browserResult: undefined },
    {
      ...report,
      browserResult: { ...report.browserResult!, evidenceRefs: [] },
    },
    {
      ...report,
      browserResult: {
        ...report.browserResult!,
        evidenceRefs: ['other-execution'],
      },
    },
    { ...report, browserResult: { ...report.browserResult!, output: '   ' } },
    {
      ...report,
      browserResult: { ...report.browserResult!, outcome: 'INCOMPLETE' },
    },
  ])
    await assert.rejects(
      store.validateReport(sql, context, invalid as VerificationReport),
      /浏览器任务/,
    );
  const blocked: VerificationReport = {
    ...report,
    executionDisposition: 'BLOCKED',
    browserResult: {
      ...report.browserResult!,
      outcome: 'INCOMPLETE',
      evidenceRefs: [],
    },
  };
  assert.equal(validateVerificationReport(blocked), true);
  await store.validateReport(sql, context, blocked);
  const legacy = {
    ...context,
    definition: { ...task, taskKind: undefined },
  } as unknown as ExecutionContext;
  await assert.rejects(
    store.validateReport(sql, legacy, report),
    /验证任务不能提交/,
  );
});

// 范围：真实 PostgreSQL、HTTP 准入、幂等、分页和重跑；不启动浏览器或真实模型，不代表业务验收。
test(
  '浏览器精简入口隔离配置并保留历史与 v2 入口',
  { timeout: 60000 },
  async () => {
    const databaseUrl = process.env.PROOFRUN_TEST_DATABASE_URL;
    assert.ok(
      databaseUrl,
      '请设置独立测试 PostgreSQL 的 PROOFRUN_TEST_DATABASE_URL',
    );
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const name = `proofrun_browser_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(databaseUrl);
    url.pathname = `/${name}`;
    const root = await mkdtemp(join(tmpdir(), 'proofrun-browser-'));
    const sql = new pg.Client({ connectionString: url.toString() });
    await sql.connect();
    const config: ApiConfig = {
      databaseUrl: url.toString(),
      adminToken: ADMIN,
      workerToken: 'browser-task-worker-fixture-only',
      publicUrl: 'http://localhost',
      artifactDirectory: root,
      host: '127.0.0.1',
      port: 0,
      workerLeaseMs: 15000,
      nodeLeaseMs: 20000,
      tickMs: 1000,
      caseProfile: {
        environment: {
          id: 'fixture',
          nodePool: 'fixture',
          allowIntervention: false,
        },
        budget: { maxActions: 20, timeoutMs: 60000 },
        evidenceKinds: ['DOM'],
      },
    };
    const app = await buildApp(config, { logger: false });
    const call = (path: string, body?: object) =>
      app.inject({
        method: body ? 'POST' : 'GET',
        url: path,
        headers: { authorization: `Bearer ${ADMIN}` },
        ...(body ? { payload: body } : {}),
      });
    try {
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/browser-tasks',
            payload: INPUT,
          })
        ).statusCode,
        401,
      );
      for (const invalid of [
        { ...INPUT, objective: ' ' },
        { ...INPUT, url: 'file:///tmp/a' },
        { ...INPUT, budget: {} },
        { ...INPUT, environment: {} },
      ])
        assert.equal(
          (await call('/v1/browser-tasks', invalid)).statusCode,
          400,
        );
      const [a, b] = await Promise.all([
        call('/v1/browser-tasks', INPUT),
        call('/v1/browser-tasks', INPUT),
      ]);
      assert.equal(a.statusCode, 202, a.body);
      assert.equal(b.statusCode, 202, b.body);
      const task = a.json().definition;
      assert.equal(task.taskKind, 'browser');
      assert.deepEqual(task.acceptanceCriteria, []);
      assert.equal(task.environment.nodePool, 'fixture');
      assert.equal(task.environment.allowIntervention, false);
      assert.equal(task.budget.maxActions, 20);
      assert.equal(a.json().reportStatus, null);
      assert.equal(
        (await call('/v1/browser-tasks', { ...INPUT, objective: '另一目标' }))
          .statusCode,
        409,
      );
      assert.equal((await call('/v1/tasks', task)).statusCode, 400);
      const { taskKind: _, ...legacy } = task;
      legacy.taskId = 'legacy-fixture';
      legacy.acceptanceCriteria = [
        {
          id: 'check',
          description: '检查',
          expectedResult: '正常',
          evidenceKinds: ['DOM'],
        },
      ];
      assert.equal((await call('/v1/tasks', legacy)).statusCode, 202);
      assert.equal(
        (await call('/v1/browser-tasks', { ...INPUT, taskId: legacy.taskId }))
          .statusCode,
        409,
      );
      const v2 = await call('/v2/cases', {
        requestId: 'v2-fixture',
        cases: [
          {
            caseId: 'v2-case',
            platform: '夹具',
            entry: INPUT.url,
            session: { mode: 'guest' },
            steps: [
              {
                type: 'verification',
                url: INPUT.url,
                exec_order: 1,
                description: '检查',
                policy: [],
                expected: ['正常'],
              },
            ],
            cleanup: [],
          },
        ],
      });
      assert.equal(v2.statusCode, 202, v2.body);
      await call('/v1/browser-tasks', { ...INPUT, taskId: 'browser-second' });
      const first = (await call('/v1/tasks?taskKind=browser&limit=1')).json();
      assert.equal(
        validateTaskList(first),
        true,
        JSON.stringify(validateTaskList.errors),
      );
      assert.equal(first.tasks.length, 1);
      assert.equal(first.tasks[0].taskKind, 'browser');
      assert.ok(first.nextCursor);
      const second = (
        await call(
          `/v1/tasks?taskKind=browser&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
        )
      ).json();
      assert.equal(second.tasks.length, 1);
      assert.notEqual(first.tasks[0].id, second.tasks[0].id);
      assert.equal(
        (await call(`/v1/tasks?cursor=${encodeURIComponent(first.nextCursor)}`))
          .statusCode,
        400,
      );
      assert.equal((await call('/v1/tasks?taskKind=unknown')).statusCode, 400);
      assert.equal((await call('/v2/requests')).json().requests.length, 1);
      const dashboard = await call('/v1/admin/statistics?period=day');
      assert.equal(dashboard.statusCode, 200, dashboard.body);
      assert.equal(dashboard.json().summary.cases.total, 2);
      assert.equal(dashboard.json().summary.runs, 2);
      await call(`/v1/tasks/${INPUT.taskId}/cancel`, {});
      const rerun = await call(`/v1/tasks/${INPUT.taskId}/rerun`, {
        runId: 'browser-rerun',
      });
      assert.equal(rerun.statusCode, 202, rerun.body);
      const fresh = (await call('/v1/tasks/browser-rerun')).json();
      assert.equal(fresh.definition.taskKind, 'browser');
      assert.deepEqual(fresh.definition.acceptanceCriteria, []);
      // 模拟平台默认值变化；重试仍须沿用首次接收时冻结的配置。
      config.caseProfile!.budget.maxActions = 15;
      const retried = await call('/v1/browser-tasks', INPUT);
      assert.equal(retried.statusCode, 202, retried.body);
      assert.equal(retried.json().definition.budget.maxActions, 20);
    } finally {
      await app.close();
      await sql.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
