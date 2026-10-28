import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/api/dist/app.js';
import {
  SimulatedNode,
  until,
  PNG,
  PNG_HASH,
} from '../../apps/api/test/fixture.ts';
import { finish } from './fixture.mjs';
const { default: pg } = await import(
  createRequire(
    new URL('../../apps/api/package.json', import.meta.url),
  ).resolve('pg')
);
/** 测试专用身份与权限，不代表部署凭据。 */
const ADMIN = 'external-test-admin',
  WORKER = 'external-test-worker';
const TOKENS = {
  full: 'external-test-full',
  other: 'external-test-other',
  read: 'external-test-read',
  browser: 'external-test-browser',
  verify: 'external-test-verify',
};
const SCOPES = [
  'browser:delegate',
  'verification:submit',
  'runs:read',
  'evidence:read',
  'runs:cancel',
  'browser:control',
  'verification:control',
];
/** 最小 Case 编译真实步骤/准备门禁，预期结果仅来自节点夹具。 */
function example() {
  return {
    caseId: randomUUID(),
    platform: '外部执行回归夹具',
    entry: 'https://example.test',
    session: { mode: 'guest' },
    steps: [
      {
        stepId: 'setup',
        type: 'setup',
        url: 'https://example.test',
        exec_order: 1,
        description: '准备页面',
        policy: ['页面已准备'],
        expected: [],
      },
      {
        stepId: 'check',
        type: 'verification',
        url: 'https://example.test',
        exec_order: 2,
        description: '核对标题',
        policy: [],
        expected: ['标题正确'],
      },
    ],
    cleanup: [
      {
        stepId: 'cleanup',
        url: 'https://example.test',
        exec_order: 3,
        description: '恢复页面',
        policy: [],
        expected: [],
      },
    ],
  };
}
/** 范围：真实 HTTP、PostgreSQL、共享执行器和命令账本；不验证真实浏览器、外部模型或业务判断质量。 */
test(
  '外部 Agent 直接执行及权限幂等闭环',
  { timeout: 120000 },
  async (suite) => {
    assert.ok(process.env.PROOFRUN_TEST_DATABASE_URL);
    const admin = new pg.Pool({
      connectionString: process.env.PROOFRUN_TEST_DATABASE_URL,
    });
    const name = `proofrun_external_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.PROOFRUN_TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    const db = new pg.Pool({ connectionString: url.toString() });
    const root = await mkdtemp(join(tmpdir(), 'proofrun-external-'));
    const config = {
      databaseUrl: url.toString(),
      adminToken: ADMIN,
      workerToken: WORKER,
      publicUrl: 'http://localhost',
      host: '127.0.0.1',
      port: 0,
      artifactDirectory: root,
      workerLeaseMs: 5000,
      nodeLeaseMs: 5000,
      tickMs: 25,
      executionRuntimeVersion: 1,
      externalIdleMs: 30000,
      publicCredentials: Object.entries(TOKENS).map(([kind, token]) => ({
        principalId: kind === 'other' ? 'other' : 'caller',
        tokenSha256: createHash('sha256').update(token).digest('hex'),
        channels: ['browser', 'verification'],
        scopes:
          kind === 'read'
            ? ['runs:read']
            : kind === 'browser'
              ? SCOPES.filter((s) => s !== 'verification:control')
              : kind === 'verify'
                ? SCOPES.filter((s) => s !== 'browser:control')
                : SCOPES,
      })),
      caseProfile: {
        environment: {
          id: 'fixture',
          nodePool: 'external',
          allowIntervention: true,
        },
        budget: { timeoutMs: 60000, maxActions: 20 },
        executionMode: 'llm',
        evidenceKinds: ['DOM'],
      },
    };
    let app = await buildApp(config, { logger: false });
    let address = await app.listen({ host: '127.0.0.1', port: 0 });
    let node;
    const http = async (method, path, body, token = TOKENS.full) => {
      const response = await fetch(address + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    const ok = async (...args) => {
      const r = await http(...args);
      assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r));
      return r.body;
    };
    const view = (id) => ok('GET', `/v3/controllers/${id}/context`);
    const ready = (id) =>
      until(
        () => view(id),
        (r) =>
          r.data.nextAction === 'ACT' || r.data.nextAction === 'READ_REPORT',
      );
    const post = (id, context, decision, operationId = randomUUID()) => ({
      operationId,
      expectedRevision: context.revision,
      observationId: context.context.page.observationId,
      ...(context.context.task.stepId
        ? { stepId: context.context.task.stepId }
        : {}),
      decision,
    });
    const settle = (operationId) =>
      until(
        () => ok('GET', `/v3/operations/${operationId}`),
        (r) => r.data.status !== 'RUNNING',
      );
    const open = async () => {
      const input = {
        operationId: randomUUID(),
        taskKey: randomUUID(),
        url: 'https://example.test',
        objective: '读取页面并完成目标',
      };
      const result = await ok('POST', '/v3/browser/sessions', input);
      return { id: result.data.controllerId, runId: result.data.runId, input };
    };
    const close = (id) =>
      ok('POST', `/v3/controllers/${id}/close`, { operationId: randomUUID() });
    const complete = async (id) => {
      const phases = [];
      const recorded = new Set();
      const partial = new Set();
      for (let i = 0; i < 30; i++) {
        const { data } = await ready(id);
        if (data.nextAction === 'READ_REPORT') return { data, phases };
        phases.push(data.context.state.phase);
        const decision = finish(data.context);
        decision.evidenceRefs = data.context.page.artifactRefs.map(
          (ref) => ref.artifactId,
        );
        if (
          data.context.task.kind === 'browser' ||
          data.context.state.phase === 'CLEANUP'
        )
          decision.progress.requirements = data.context.state.requirements.map(
            (item) => ({
              id: item.id,
              status: 'complete',
              summary: '夹具目标完成',
              evidenceRefs: data.context.page.artifactRefs.map(
                (ref) => ref.artifactId,
              ),
            }),
          );
        if (data.context.state.phase === 'CHECKING')
          assert.ok(!data.allowedActions.includes('browser.act'));
        if (
          data.context.task.kind === 'verification' &&
          data.context.state.phase === 'VERIFYING' &&
          !recorded.has(data.context.task.stepId)
        ) {
          // 同批有效 criterion 已入账后，未知 requirement 被拒绝也不能抹掉它。
          if (!partial.has(data.context.task.stepId)) {
            partial.add(data.context.task.stepId);
            const mixed = post(id, data, {
              type: 'verification.record',
              summary: '夹具部分有效进度',
              progress: {
                ...decision.progress,
                requirements: [
                  {
                    id: 'unknown-requirement',
                    status: 'complete',
                    summary: '非法要求身份',
                    evidenceRefs: decision.evidenceRefs,
                  },
                ],
              },
            });
            await ok(
              'POST',
              `/v3/controllers/${id}/steps/${data.context.task.stepId}/progress`,
              mixed,
            );
            const receipt = await settle(mixed.operationId);
            assert.equal(receipt.data.status, 'FAILED');
            assert.equal(receipt.data.progressApplied, true);
            continue;
          }
          recorded.add(data.context.task.stepId);
          const payload = post(id, data, {
            type: 'verification.record',
            summary: '夹具逐项进度',
            progress: decision.progress,
          });
          await ok(
            'POST',
            `/v3/controllers/${id}/steps/${data.context.task.stepId}/progress`,
            payload,
          );
          assert.equal(
            (await settle(payload.operationId)).data.progressApplied,
            true,
          );
          continue;
        }
        const payload = post(id, data, decision);
        await ok('POST', `/v3/controllers/${id}/decisions`, payload);
        const receipt = await settle(payload.operationId);
        assert.equal(
          receipt.data.status,
          'SUCCEEDED',
          JSON.stringify({ receipt, context: data.context }),
        );
      }
      throw new Error('未收敛');
    };
    try {
      // 范围：运行冻结、延迟绑定和内置领取隔离；无节点，不覆盖浏览器启动。
      let formal;
      await suite.test(
        'external 提交无绑定不分配，内置 worker 不可领取，绑定不复活',
        async () => {
          const created = await ok('POST', '/v3/verification/requests', {
            requestId: randomUUID(),
            cases: [example()],
            executor: { kind: 'external' },
          });
          formal = created.data.runs[0].runId;
          assert.equal(created.data.runs[0].executor.kind, 'external');
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int AS n FROM pr_executions WHERE task_id=$1',
                [formal],
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await ok(
                'POST',
                '/v1/worker/claim',
                {
                  type: 'worker.claim',
                  workerId: 'fixture',
                  runtimeVersion: 1,
                  structuredSteps: true,
                  stepBudgetVersion: 1,
                  identityVersion: 2,
                  profileTabsVersion: 1,
                  executionPlanVersion: 1,
                },
                WORKER,
              )
            ).execution,
            null,
          );
          const denied = await http(
            'POST',
            `/v3/runs/${formal}/controller`,
            { operationId: randomUUID() },
            TOKENS.browser,
          );
          assert.equal(denied.status, 403);
        },
      );
      node = new SimulatedNode(address, 'external', 4);
      node.fullProfile = true;
      const original = node.execute.bind(node);
      node.execute = (command) => {
        original(command);
        for (const ref of node.results.get(command.commandId)?.data
          ?.artifactRefs ?? []) {
          if (ref.kind !== 'SCREENSHOT') continue;
          void (async () => {
            await until(
              async () => {
                const r = await fetch(
                  address + `/v1/artifacts/${ref.artifactId}`,
                  {
                    method: 'PUT',
                    headers: {
                      authorization: `Bearer ${node.token}`,
                      'content-type': 'image/png',
                      'x-content-sha256': PNG_HASH,
                    },
                    body: PNG,
                  },
                );
                return r.status;
              },
              (status) => status === 200,
            );
            node.send({
              type: 'artifact.available',
              messageId: `artifact:${ref.artifactId}`,
              artifactId: ref.artifactId,
              sha256: PNG_HASH,
            });
          })().catch((error) => {
            console.error(error);
          });
        }
      };
      await node.pair(ADMIN);
      await until(
        () => ok('GET', '/v1/nodes', undefined, ADMIN),
        (v) => v.nodes.some((n) => n.id === node.id && n.online),
      );
      // 范围：正式 Case 的准备、核验、步骤进度、报告收敛和未知模型用量；不证明夹具断言为真实业务事实。
      await suite.test(
        '外部完成 Case 全流程，复用门禁且平台无模型调用',
        async () => {
          const bound = await ok('POST', `/v3/runs/${formal}/controller`, {
            operationId: randomUUID(),
          });
          const id = bound.data.controllerId;
          const initial = (await ready(id)).data;
          assert.equal(initial.nextAction, 'ACT', JSON.stringify(initial));
          const forbidden = post(id, initial, { type: 'browser.observe' });
          assert.equal(
            (
              await http(
                'POST',
                `/v3/controllers/${id}/decisions`,
                forbidden,
                TOKENS.verify,
              )
            ).status,
            403,
          );
          assert.equal(
            (
              await http('POST', `/v3/controllers/${id}/decisions`, {
                ...forbidden,
                report: { verdict: 'PASSED' },
              })
            ).status,
            400,
          );
          const attached = post(id, initial, {
            type: 'browser.observe',
            progress: {
              requirements: [
                {
                  id: initial.context.state.requirements[0].id,
                  status: 'complete',
                  summary: '未经授权声明',
                  evidenceRefs: initial.context.page.artifactRefs.map(
                    (ref) => ref.artifactId,
                  ),
                },
              ],
            },
          });
          assert.equal(
            (
              await http(
                'POST',
                `/v3/controllers/${id}/decisions`,
                attached,
                TOKENS.browser,
              )
            ).status,
            403,
          );
          const premature = post(id, initial, {
            type: 'verification.finish',
            summary: '尚未完成准备',
            progress: {},
            evidenceRefs: initial.context.page.artifactRefs.map(
              (ref) => ref.artifactId,
            ),
          });
          await ok('POST', `/v3/controllers/${id}/decisions`, premature);
          assert.equal(
            (await settle(premature.operationId)).data.status,
            'FAILED',
          );
          assert.equal((await ready(id)).data.context.state.phase, 'PREPARING');
          const result = await complete(id);
          assert.ok(result.phases.includes('PREPARING'));
          assert.ok(result.phases.includes('CHECKING'));
          assert.equal(result.data.report.executor.kind, 'external');
          assert.ok(
            result.data.report.steps.every(
              (step) =>
                step.budgetUsage.modelCalls === 0 &&
                step.budgetUsage.decisionCalls > 0,
            ),
          );
          assert.equal(result.data.report.executor.modelCalls, null);
          assert.equal(result.data.report.executor.usageSource, 'unavailable');
          assert.ok(result.data.report.executor.decisionCalls >= 2);
          assert.equal(
            result.data.report.verdict,
            'PASSED',
            JSON.stringify(result.data.report),
          );
          assert.equal(
            (await db.query('SELECT count(*)::int AS n FROM pr_model_calls'))
              .rows[0].n,
            0,
          );
          assert.equal(
            (
              await http('POST', `/v3/runs/${formal}/controller`, {
                operationId: randomUUID(),
              })
            ).status,
            410,
          );
        },
      );
      // 范围：相同决定并发重试、版本和归属；节点调用次数来自夹具命令账本。
      await suite.test('浏览器观察幂等、权限隔离与上下文版本冲突', async () => {
        const session = await open();
        const initial = (await ready(session.id)).data;
        assert.equal(initial.nextAction, 'ACT', JSON.stringify(initial));
        assert.deepEqual(
          (await ok('POST', '/v3/browser/sessions', session.input)).data
            .controllerId,
          session.id,
        );
        for (const token of [ADMIN, WORKER])
          assert.equal(
            (
              await http(
                'GET',
                `/v3/controllers/${session.id}`,
                undefined,
                token,
              )
            ).status,
            401,
          );
        assert.equal(
          (
            await http(
              'GET',
              `/v3/controllers/${session.id}`,
              undefined,
              TOKENS.other,
            )
          ).status,
          404,
        );
        const payload = post(session.id, initial, { type: 'browser.observe' });
        assert.equal(
          (
            await http(
              'POST',
              `/v3/controllers/${session.id}/observations`,
              payload,
              TOKENS.read,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await http('POST', `/v3/controllers/${session.id}/observations`, {
              ...payload,
              observationId: 'stale',
            })
          ).status,
          409,
        );
        const replies = await Promise.all([
          ok('POST', `/v3/controllers/${session.id}/observations`, payload),
          ok('POST', `/v3/controllers/${session.id}/observations`, payload),
        ]);
        assert.equal(replies[0].data.operationId, replies[1].data.operationId);
        assert.equal(
          (await settle(payload.operationId)).data.status,
          'SUCCEEDED',
        );
        assert.equal(
          (
            await http('POST', `/v3/controllers/${session.id}/observations`, {
              ...payload,
              operationId: randomUUID(),
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await http('POST', `/v3/controllers/${session.id}/decisions`, {
              ...payload,
              decision: {
                type: 'browser.wait',
                selector: 'body',
                text: 'fixture',
              },
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await http(
              'POST',
              `/v3/controllers/${session.id}/observations`,
              payload,
              TOKENS.read,
            )
          ).status,
          403,
        );
        const row = (
          await db.query(
            'SELECT command_ids FROM pr_external_operations WHERE id=$1',
            [payload.operationId],
          )
        ).rows[0];
        assert.equal(row.command_ids.length, 1);
        assert.equal(node.calls.get(row.command_ids[0]), 1);
        const result = await complete(session.id);
        assert.equal(result.data.report.executor.kind, 'external');
      });
      // 范围：合法进度先落库后目标校验失败；不把保存目标声明当成浏览器真实成功。
      await suite.test(
        '失败动作保留同批合法进度，证据只读当前所属运行',
        async () => {
          const session = await open();
          const { data } = await ready(session.id);
          const ref = data.context.page.artifactRefs.find(
            (ref) => ref.kind === 'DOM',
          );
          assert.ok(ref);
          assert.equal(
            (
              await http(
                'GET',
                `/v3/runs/${session.runId}/evidence/${ref.artifactId}`,
              )
            ).status,
            200,
          );
          assert.equal(
            (await http('GET', `/v3/runs/${formal}/evidence/${ref.artifactId}`))
              .status,
            404,
          );
          const decision = {
            type: 'browser.act',
            action: 'click',
            target: 'missing-target',
            progress: {
              requirements: data.context.state.requirements.map((item) => ({
                id: item.id,
                status: 'complete',
                summary: '夹具已读',
                evidenceRefs: [ref.artifactId],
              })),
            },
          };
          const payload = post(session.id, data, decision);
          await ok('POST', `/v3/controllers/${session.id}/actions`, payload);
          const receipt = await settle(payload.operationId);
          assert.equal(receipt.data.status, 'FAILED');
          assert.equal(receipt.data.progressApplied, true);
          assert.equal(receipt.data.effect, 'NOT_STARTED');
          assert.ok(
            (await ready(session.id)).data.context.state.requirements.every(
              (item) => item.status === 'recorded',
            ),
          );
          await close(session.id);
        },
      );
      // 范围：未知写操作只派发一次、停止运行；模拟节点 UNKNOWN 不能证明真实副作用是否发生。
      await suite.test('未知动作不重放，原操作键持续返回 UNKNOWN', async () => {
        const session = await open();
        const { data } = await ready(session.id);
        node.unknownWrite = true;
        try {
          const payload = post(session.id, data, {
            type: 'browser.act',
            action: 'navigate',
            target: 'https://example.test/next',
          });
          await ok('POST', `/v3/controllers/${session.id}/actions`, payload);
          const receipt = await settle(payload.operationId);
          assert.equal(receipt.data.status, 'UNKNOWN');
          assert.equal(receipt.data.effect, 'UNKNOWN');
          assert.equal(
            (await ok('POST', `/v3/controllers/${session.id}/actions`, payload))
              .data.status,
            'UNKNOWN',
          );
          const row = (
            await db.query(
              'SELECT command_ids FROM pr_external_operations WHERE id=$1',
              [payload.operationId],
            )
          ).rows[0];
          assert.ok(row.command_ids.length);
          for (const command of row.command_ids)
            assert.equal(node.calls.get(command), 1);
          await until(
            () => view(session.id),
            (r) => r.data.state !== 'ACTIVE',
          );
        } finally {
          node.unknownWrite = false;
        }
      });
      // 范围：真实 HTTP/数据库等待自然到期后留出收尾窗口并拒绝旧帧；页面仍由节点夹具提供。
      await suite.test(
        '外部探索等待到期发布只读新帧，原期限内完成报告',
        async () => {
          const savedTimeout = config.caseProfile.budget.timeoutMs;
          let session;
          try {
            config.caseProfile.budget.timeoutMs = 20000;
            session = await open();
          } finally {
            config.caseProfile.budget.timeoutMs = savedTimeout;
          }
          const initial = (await ready(session.id)).data;
          assert.equal(initial.context.state.settlement, null);
          assert(
            initial.context.budget.decisionTimeMs <
              initial.context.budget.timeMs,
          );
          // 仅在隔离测试库中延迟一个操作的登记，使决定在数据库提交期间跨过探索期限。
          const racing = post(session.id, initial, { type: 'browser.observe' });
          await db.query(`CREATE FUNCTION delay_external_test() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.id = '${racing.operationId}' THEN PERFORM pg_sleep(2); END IF; RETURN NEW; END $$`);
          await db.query(
            'CREATE TRIGGER delay_external_test BEFORE INSERT ON pr_external_operations FOR EACH ROW EXECUTE FUNCTION delay_external_test()',
          );
          try {
            await until(
              () => view(session.id),
              (r) => r.data.context.budget.decisionTimeMs < 1000,
              20000,
            );
            const rejected = await http(
              'POST',
              `/v3/controllers/${session.id}/decisions`,
              racing,
            );
            assert.equal(rejected.status, 409);
            assert.equal(rejected.body.code, 'REVISION_CONFLICT');
            const receipt = await settle(racing.operationId);
            assert.equal(receipt.data.status, 'FAILED');
            assert.equal(receipt.data.effect, 'NOT_STARTED');
            assert.equal(receipt.data.error.code, 'REVISION_CONFLICT');
            const replay = await ok(
              'POST',
              `/v3/controllers/${session.id}/decisions`,
              racing,
            );
            assert.equal(replay.data.status, 'FAILED');
          } finally {
            await db.query(
              'DROP TRIGGER delay_external_test ON pr_external_operations',
            );
            await db.query('DROP FUNCTION delay_external_test()');
          }
          const { data: final } = await until(
            () => view(session.id),
            (r) =>
              r.data.nextAction === 'ACT' &&
              r.data.context.state.settlement === 'budget',
            20000,
          );
          assert(final.revision > initial.revision);
          assert(final.context.budget.timeMs > 0);
          assert(final.context.budget.timeMs < initial.context.budget.timeMs);
          assert(
            final.context.feedback.some(
              (f) => f.code === 'SETTLEMENT_REQUIRED',
            ),
          );
          assert(!final.allowedActions.includes('browser.act'));
          const stale = await http(
            'POST',
            `/v3/controllers/${session.id}/decisions`,
            post(session.id, initial, { type: 'browser.observe' }),
          );
          assert.equal(stale.status, 409);
          assert.equal(stale.body.code, 'REVISION_CONFLICT');
          const result = await complete(session.id);
          assert.equal(result.data.report.verdict, null);
          assert.equal(result.data.report.browserResult.outcome, 'COMPLETED');
          // 报告先完成，物理浏览器回收是异步事实，不能由 READ_REPORT 推断已经关闭。
          const closed = await until(
            () => view(session.id),
            (r) => r.data.closureVerified,
          );
          assert.equal(closed.data.nextAction, 'READ_REPORT');
        },
      );
      // 范围：主动关闭及过期绑定不可复活；不把关闭请求当作节点关闭确认。
      await suite.test(
        'touch 仅延长空闲期限，关闭后幂等读取不重新执行',
        async () => {
          const session = await open();
          const current = (await ready(session.id)).data;
          assert.equal(
            (await view(session.id)).data.idleDeadlineAt,
            current.idleDeadlineAt,
          );
          await ok('POST', `/v3/controllers/${session.id}/touch`, {
            operationId: randomUUID(),
          });
          const touched = (await view(session.id)).data;
          assert.equal(touched.revision, current.revision);
          // 范围：真实 HTTP 连续读取/touch 不冻结或延长决定窗口；不校准生产网络延迟。
          assert.equal(current.context.budget.timingState, 'live');
          assert(touched.context.budget.timeMs < current.context.budget.timeMs);
          assert.equal(
            touched.context.budget.stepDeadlineAt,
            current.context.budget.stepDeadlineAt,
          );
          assert.equal(
            touched.context.budget.decisionDeadlineAt,
            current.context.budget.decisionDeadlineAt,
          );
          assert(
            touched.context.budget.decisionTimeMs <=
              touched.context.budget.timeMs,
          );
          assert.equal(
            touched.executor.decisionCalls,
            current.executor.decisionCalls,
          );
          await close(session.id);
          assert.equal(
            (
              await http('POST', `/v3/controllers/${session.id}/touch`, {
                operationId: randomUUID(),
              })
            ).status,
            410,
          );
          const replay = await ok(
            'POST',
            '/v3/browser/sessions',
            session.input,
          );
          assert.equal(replay.data.controllerId, session.id);
          assert.notEqual((await view(session.id)).data.state, 'ACTIVE');
          const idle = await open();
          await ready(idle.id);
          await db.query(
            "UPDATE pr_external_controllers SET idle_deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [idle.id],
          );
          await until(
            () => view(idle.id),
            (r) => r.data.state === 'EXPIRED',
          );
          assert.equal(
            (
              await http('POST', `/v3/controllers/${idle.id}/touch`, {
                operationId: randomUUID(),
              })
            ).status,
            410,
          );
        },
      );
      // 范围：管理员接管撤销旧上下文；不覆盖真实人工浏览器输入或账号确认。
      await suite.test('人工接管期间拒绝旧决定并保持续租', async () => {
        const session = await open();
        const current = (await ready(session.id)).data;
        const row = (
          await db.query(
            'SELECT execution_id FROM pr_external_controllers WHERE id=$1',
            [session.id],
          )
        ).rows[0];
        await ok(
          'POST',
          `/v1/admin/executions/${row.execution_id}/intervene`,
          {
            type: 'execution.intervene',
            controlRevision: 0,
            reason: '夹具接管',
          },
          ADMIN,
        );
        const human = await until(
          () => view(session.id),
          (r) => r.data.nextAction === 'HUMAN_REQUIRED',
        );
        assert.deepEqual(human.data.allowedActions, []);
        assert.equal(
          (
            await http(
              'POST',
              `/v3/controllers/${session.id}/observations`,
              post(session.id, current, { type: 'browser.observe' }),
            )
          ).status,
          409,
        );
        await close(session.id);
      });
      // 范围：无绑定任务的等待期限；不分配节点、不自动回退到内置 Agent。
      await suite.test(
        '未绑定的 external Case 到期后不能领取或重新绑定',
        async () => {
          const created = await ok('POST', '/v3/verification/requests', {
            requestId: randomUUID(),
            cases: [example()],
            executor: { kind: 'external' },
          });
          const runId = created.data.runs[0].runId;
          await db.query(
            "UPDATE pr_tasks SET binding_deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [runId],
          );
          await until(
            async () =>
              (
                await db.query('SELECT state FROM pr_tasks WHERE id=$1', [
                  runId,
                ])
              ).rows[0].state,
            (state) => state === 'TIMED_OUT',
          );
          assert.equal(
            (
              await http('POST', `/v3/runs/${runId}/controller`, {
                operationId: randomUUID(),
              })
            ).status,
            410,
          );
          assert.equal(
            (
              await db.query(
                'SELECT count(*)::int AS n FROM pr_executions WHERE task_id=$1',
                [runId],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      // 范围：在途排他与重启遗留记录的 fail-closed 恢复；以数据库夹具模拟丢失的进程栈，不模拟操作系统崩溃。
      await suite.test(
        '同一控制器只有一个在途决定，重启将遗留操作标为 UNKNOWN',
        async () => {
          const session = await open();
          const current = (await ready(session.id)).data;
          const payload = post(session.id, current, {
            type: 'browser.wait',
            selector: 'body',
            text: 'never',
          });
          await ok('POST', `/v3/controllers/${session.id}/waits`, payload);
          await until(
            async () =>
              (
                await db.query(
                  'SELECT command_ids FROM pr_external_operations WHERE id=$1',
                  [payload.operationId],
                )
              ).rows[0].command_ids.length,
            (n) => n > 0,
          );
          const conflict = await http(
            'POST',
            `/v3/controllers/${session.id}/observations`,
            post(session.id, current, { type: 'browser.observe' }),
          );
          assert.equal(conflict.status, 409);
          assert.equal(conflict.body.code, 'OPERATION_IN_FLIGHT');
          assert.equal(
            (await view(session.id)).data.pendingOperation,
            payload.operationId,
          );
          await app.close();
          await node.close();
          node = undefined;
          await db.query(
            "UPDATE pr_external_controllers SET state='ACTIVE' WHERE id=$1",
            [session.id],
          );
          await db.query(
            "UPDATE pr_external_operations SET state='RUNNING',result=NULL WHERE id=$1",
            [payload.operationId],
          );
          const before = (
            await db.query('SELECT count(*)::int AS n FROM pr_commands')
          ).rows[0].n;
          app = await buildApp(config, { logger: false });
          address = await app.listen({ host: '127.0.0.1', port: 0 });
          assert.equal((await view(session.id)).data.state, 'LOST');
          assert.equal(
            (await settle(payload.operationId)).data.status,
            'UNKNOWN',
          );
          assert.equal(
            (await ok('POST', `/v3/controllers/${session.id}/waits`, payload))
              .data.status,
            'UNKNOWN',
          );
          assert.equal(
            (await db.query('SELECT count(*)::int AS n FROM pr_commands'))
              .rows[0].n,
            before,
          );
          const serialized = JSON.stringify(
            (
              await db.query(
                'SELECT row_to_json(c) AS value FROM pr_external_controllers c',
              )
            ).rows,
          );
          for (const token of Object.values(TOKENS))
            assert.ok(!serialized.includes(token));
        },
      );
    } finally {
      await app.close();
      await node?.close();
      await db.end();
      await rm(root, { recursive: true, force: true });
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);
