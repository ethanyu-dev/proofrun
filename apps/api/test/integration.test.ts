import WebSocket from 'ws';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import pg from 'pg';
import { retain } from '../src/maintenance.js';
import { Database } from '../src/db.js';
import { canonical, digest } from '../src/domain.js';
import { buildApp } from '../src/app.js';
import type { CaseProfile } from '../src/modules/cases/profile.js';
import {
  validateTaskList,
  validateTaskDetail,
  validateNodeList,
  validateExecutionActivity,
  validateCaseResult,
  validateCaseResultV2,
  validateExecutionGrant,
  type TaskList,
  type VerificationTask,
} from '@proofrun/contracts';
import {
  PNG,
  PNG_HASH,
  TRACE,
  TRACE_HASH,
  SimulatedNode,
  connectHitl,
  SimulatedWorker,
  task,
  until,
} from './fixture.js';

/** 测试凭据只用于新建的临时数据库和回环监听。 */
const ADMIN = 'proofrun-admin-integration-only-credential';
const WORKER = 'proofrun-worker-integration-only-credential';
/** 明确跨越初始租约边界；不改变控制面配置或轮询超时。 */
const LEASE_BOUNDARY_MARGIN_MS = 100;
/** 状态读取回归保留原有截止时间，超时用于发现锁等待，不作为生产性能承诺。 */
const SNAPSHOT_REQUEST_MS = 1500;
/** 超过 API 业务连接池的读请求数，确保写锁回归会形成可观察的排队。 */
const SNAPSHOT_READERS = 20;

// 范围：真实 PostgreSQL、HTTP 与 WebSocket 的控制面约束；浏览器行为由协议夹具模拟。
test('控制面持久化与故障集成', { timeout: 90_000 }, async (suite) => {
  const databaseUrl = process.env.PROOFRUN_TEST_DATABASE_URL;
  assert.ok(
    databaseUrl,
    '请为独立测试 PostgreSQL 设置 PROOFRUN_TEST_DATABASE_URL',
  );
  const root = await mkdtemp(join(tmpdir(), 'proofrun-api-test-'));
  const databaseName = `proofrun_test_${randomUUID().replaceAll('-', '')}`;
  const adminDb = new pg.Pool({ connectionString: databaseUrl });
  await adminDb.query(`CREATE DATABASE ${databaseName}`);
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  const portHolder = createServer();
  await new Promise<void>((resolve) =>
    portHolder.listen(0, '127.0.0.1', resolve),
  );
  const port = (portHolder.address() as { port: number }).port;
  await new Promise<void>((resolve) => portHolder.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const config = {
    caseProfile: {
      environment: { id: 'private-case-environment', nodePool: 'case-fixture' },
      budget: { timeoutMs: 60000, maxActions: 20 },
      executionMode: 'llm' as const,
      evidenceKinds: ['DOM' as const],
    } satisfies CaseProfile,
    databaseUrl: url.toString(),
    adminToken: ADMIN,
    workerToken: WORKER,
    publicUrl: base,
    artifactDirectory: join(root, 'artifacts'),
    host: '127.0.0.1',
    port,
    workerLeaseMs: 4000,
    nodeLeaseMs: 4000,
    tickMs: 50,
  };
  let app = await buildApp(config, { logger: false });
  await app.listen({ port, host: '127.0.0.1' });
  const nodes: SimulatedNode[] = [];
  let archivedScreenshot = '';
  const sql = new pg.Pool({ connectionString: url.toString() });
  const api = async (
    method: string,
    path: string,
    body?: unknown,
    token = ADMIN,
  ) => {
    // 旧的单步协议夹具补齐新版身份字段；错误身份、跨组证据和并发行为另有专门回归。
    const executionPath = /^\/v1\/executions\/([^/]+)\//.exec(path);
    if (method === 'POST' && body && executionPath) {
      const stored = (
        await sql.query(
          'SELECT t.definition,t.step_results FROM pr_executions e JOIN pr_tasks t ON t.id=e.task_id WHERE e.id=$1',
          [executionPath[1]],
        )
      ).rows[0];
      const plan = stored?.definition.profilePlan;
      if (plan) {
        const payload = body as any;
        const active = stored.step_results?.find(
          (step: any) => step.status === 'RUNNING',
        )?.stepId;
        if (
          payload.type === 'execution.command' &&
          active &&
          payload.command.type !== 'browser.identity.prepare'
        ) {
          payload.stepId ??= active;
          payload.command.tabScope ??=
            plan.groups.find((group: any) =>
              group.stepIds.includes(payload.stepId),
            )?.id ?? 'profile-cleanup';
        }
        if (payload.phase === 'start' && active)
          payload.record.stepId ??= active;
        const states = Array.isArray(payload) ? payload : payload.report?.steps;
        for (const state of states ?? []) {
          const group = plan.groups.find((group: any) =>
            group.stepIds.includes(state.stepId),
          );
          if (group) state.groupId ??= group.id;
          if (
            group &&
            state.status === 'COMPLETED' &&
            stored.definition.steps.find(
              (step: any) => step.stepId === state.stepId,
            )?.type === 'setup'
          )
            state.phase ??= 'READY';
        }
      }
    }
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json();
    // 范围：实际接口输出符合共享读取契约，且受管理的响应禁止缓存；不验证页面排版。
    if (response.ok && path === '/v1/nodes')
      assert.ok(
        validateNodeList(data),
        JSON.stringify(validateNodeList.errors),
      );
    if (
      response.ok &&
      !path.endsWith('/rerun') &&
      !path.endsWith('/compare') &&
      !path.endsWith('/comparison') &&
      (path.startsWith('/v1/tasks/') ||
        (path === '/v1/tasks' && method === 'POST'))
    )
      assert.ok(
        validateTaskDetail(data),
        JSON.stringify(validateTaskDetail.errors),
      );
    if (response.ok && path.startsWith('/v1/tasks?'))
      assert.ok(
        validateTaskList(data),
        JSON.stringify(validateTaskList.errors),
      );
    if (
      response.ok &&
      path.startsWith('/v1/') &&
      token === ADMIN &&
      path !== '/v1/nodes/pair'
    )
      assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, data };
  };
  const addNode = async (pool: string, simulatedSessionLimit = 1) => {
    const node = new SimulatedNode(base, pool, simulatedSessionLimit);
    nodes.push(node);
    await node.pair(ADMIN);
    await until(
      async () => (await api('GET', '/v1/nodes')).data.nodes,
      (rows) =>
        rows.some(
          (r: { id: string; online: boolean }) => r.id === node.id && r.online,
        ),
    );
    return node;
  };
  const submit = async (definition: ReturnType<typeof task>) => {
    assert.equal((await api('POST', '/v1/tasks', definition)).status, 202);
  };
  const claim = async (structuredSteps = false) =>
    (
      await api(
        'POST',
        '/v1/worker/claim',
        {
          type: 'worker.claim',
          workerId: randomUUID(),
          structuredSteps,
          ...(structuredSteps
            ? {
                stepBudgetVersion: 1,
                identityVersion: 1,
                profileTabsVersion: 1,
                executionPlanVersion: 1,
              }
            : {}),
        },
        WORKER,
      )
    ).data.execution;
  const ready = async (execution: { id: string; leaseToken: string }) =>
    until(
      async () =>
        (
          await api(
            'GET',
            `/v1/executions/${execution.id}`,
            undefined,
            execution.leaseToken,
          )
        ).data,
      (value) => value.state === 'RUNNING',
    );
  const command = async (
    execution: { id: string; leaseToken: string },
    operation: unknown,
    id = randomUUID(),
  ) => {
    const request = {
      type: 'execution.command',
      commandId: id,
      timeoutMs: 15_000,
      command: operation,
    };
    const submitted = await api(
      'POST',
      `/v1/executions/${execution.id}/commands`,
      request,
      execution.leaseToken,
    );
    assert.equal(submitted.status, 202, JSON.stringify(submitted));
    const result = await until(
      async () =>
        (
          await api(
            'GET',
            `/v1/executions/${execution.id}/commands/${id}`,
            undefined,
            execution.leaseToken,
          )
        ).data.result,
      (value) => Boolean(value),
    );
    return { request, result };
  };
  const cleaned = async (id: string) =>
    until(
      async () => (await api('GET', `/v1/tasks/${id}`)).data,
      (value) =>
        value.executions.every(
          (e: { closure_verified: boolean }) => e.closure_verified,
        ),
    );
  try {
    // 范围：真实 HTTP/数据库冻结偏好、能力升级门禁和缺失证明拒绝；节点和浏览器由协议夹具模拟。
    await suite.test(
      '动画偏好等待新版节点，传递显式配置并拒绝缺失证明',
      async () => {
        const node = await addNode('motion-preference');
        node.reducedMotion = false;
        node.heartbeat();
        const capability = async () =>
          (
            await sql.query('SELECT capabilities FROM pr_nodes WHERE id=$1', [
              node.id,
            ])
          ).rows[0].capabilities.reducedMotion;
        await until(capability, (value) => value === false);
        for (const [index, preference] of [true, false, true].entries()) {
          const definition = {
            ...task(node.pool),
            sessionPlan: {
              version: 1 as const,
              mode: 'guest' as const,
              candidates: [],
              requirements: [],
              preparationMs: 120000,
              reducedMotion: preference,
            },
          };
          await submit(definition);
          if (index === 0) {
            assert.equal(await claim(true), null);
            assert.equal(node.sessions.size, 0);
            node.reducedMotion = true;
            node.heartbeat();
            await until(capability, (value) => value === true);
          }
          node.motionProof = index !== 2;
          const execution = await claim(true);
          assert.ok(execution);
          if (index === 2) {
            const detail = await until(
              async () =>
                (await api('GET', `/v1/tasks/${definition.taskId}`)).data,
              (value) => value.state === 'ERROR',
            );
            assert.equal(detail.error.code, 'MOTION_PREFERENCE_MISMATCH');
          } else {
            const view = await ready(execution);
            assert.equal(view.environmentProof.reducedMotion, preference);
            const open = node.sessions.get(execution.sessionId)!;
            assert.equal(open.command.type, 'session.open');
            if (open.command.type === 'session.open')
              assert.equal(open.command.reducedMotion, preference);
            await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
          }
          await cleaned(definition.taskId);
        }
      },
    );
    // 范围：真实心跳、数据库与 HTTP 的版本更新/持久化及执行快照；不验证真实节点构建或浏览器。
    await suite.test(
      '节点上报版本并冻结执行快照，旧节点回退不沿用旧版本',
      async () => {
        const node = await addNode('runtime-version');
        const readNode = async () =>
          (await api('GET', '/v1/nodes')).data.nodes.find(
            (n: { id: string }) => n.id === node.id,
          );
        assert.equal((await readNode()).runtime, null);
        const first = {
          version: 'node-v0.1.0-alpha.6',
          sourceCommit: 'a'.repeat(40),
          engineVersion: '0.38.1',
        };
        node.runtime = first;
        node.heartbeat();
        await until(readNode, (n) => n.runtime?.version === first.version);
        const definition = task('runtime-version');
        await submit(definition);
        const execution = await claim();
        assert.ok(execution);
        await ready(execution);
        await api('POST', `/v1/tasks/${definition.taskId}/cancel`, {});
        const detail = await cleaned(definition.taskId);
        assert.deepEqual(detail.executions[0].node_runtime, first);
        const second = {
          ...first,
          version: 'node-v0.1.0-alpha.7',
          sourceCommit: 'b'.repeat(40),
        };
        node.runtime = second;
        node.heartbeat();
        await until(readNode, (n) => n.runtime?.version === second.version);
        // 读取持久库确认不是仅存于 WebSocket 连接；历史任务仍保留原版本。
        assert.deepEqual(
          (
            await sql.query('SELECT runtime FROM pr_nodes WHERE id=$1', [
              node.id,
            ])
          ).rows[0].runtime,
          second,
        );
        assert.deepEqual(
          (await api('GET', `/v1/tasks/${definition.taskId}`)).data
            .executions[0].node_runtime,
          first,
        );
        delete node.runtime;
        node.heartbeat();
        await until(readNode, (n) => n.runtime === null);
        const legacy = task('runtime-version');
        await submit(legacy);
        const oldExecution = await claim();
        assert.ok(oldExecution);
        await ready(oldExecution);
        await api('POST', `/v1/tasks/${legacy.taskId}/cancel`, {});
        assert.equal(
          (await cleaned(legacy.taskId)).executions[0].node_runtime,
          null,
        );
        assert.deepEqual(
          (await api('GET', `/v1/tasks/${definition.taskId}`)).data
            .executions[0].node_runtime,
          first,
        );
      },
    );
    // 范围：真实路由已下线且旧身份协议被拒绝；不执行真实账号或浏览器登录。
    await suite.test('本地身份管理与选择接口已移除', async () => {
      for (const [method, path] of [
        ['GET', '/v1/admin/identity-library'],
        ['POST', '/v1/admin/identity-library'],
        ['POST', '/v1/admin/identity-library/remove'],
        ['GET', '/v1/admin/identities'],
        ['GET', '/v1/admin/identities/settings'],
        ['POST', '/v1/admin/identities/settings'],
        ['POST', '/v1/admin/identities/test'],
        ['POST', '/v1/admin/identities/refresh'],
        ['GET', '/v1/admin/identities/metrics'],
        ['POST', '/v1/worker/identity-selection/claim'],
        ['POST', '/v1/worker/identity-selection/finish'],
      ])
        assert.equal(
          (await api(method!, path!, method === 'POST' ? {} : undefined))
            .status,
          404,
        );
    });

    // 范围：真实 PostgreSQL 批量事务、同站点任务独立、逐步证据和清理顺序；节点为协议夹具，不执行业务浏览器。
    await suite.test('v2 批量原子接收、独立任务与同会话清理', async () => {
      const node = await addNode('case-fixture', 3);
      const step = {
        type: 'verification',
        url: 'https://v2.example.test/result',
        exec_order: 2,
        description: '检查结果',
        policy: [],
        expected: ['结果正确'],
      };
      const input = {
        caseId: 'v2-first',
        platform: '协议夹具',
        entry: 'https://v2.example.test',
        steps: [step],
        cleanup: [
          { url: step.url, exec_order: 1, description: '恢复明确的测试值' },
          { url: step.url, exec_order: 2, description: '核实清理后的状态' },
        ],
      };
      const submitted = await api('POST', '/v2/cases', [
        input,
        { ...input, caseId: 'v2-second', cleanup: [] },
        {
          ...input,
          caseId: 'v2-independent',
          entry: 'https://independent.example.test',
          cleanup: [],
        },
      ]);
      assert.equal(submitted.status, 202, JSON.stringify(submitted));
      assert(
        submitted.data.every((value: unknown) => validateCaseResultV2(value)),
        JSON.stringify(validateCaseResultV2.errors),
      );
      assert.equal((await api('POST', '/v2/cases', [input])).status, 202);
      assert.equal(
        (
          await api('POST', '/v2/cases', [
            { ...input, caseId: 'v2-atomic-new' },
            { ...input, platform: '冲突定义' },
          ])
        ).status,
        409,
      );
      assert.equal((await api('GET', '/v2/cases/v2-atomic-new')).status, 404);
      assert.equal(await claim(), null);
      const first = await claim(true);
      await ready(first);
      const second = await claim(true);
      await ready(second);
      const independent = await claim(true);
      assert.equal(first.task.taskId, 'case-v2-v2-first');
      assert.equal(second.task.taskId, 'case-v2-v2-second');
      assert.equal(independent.task.taskId, 'case-v2-v2-independent');
      assert.equal(first.task.resourceKey, undefined);
      assert.equal(second.task.resourceKey, undefined);
      assert.equal(await claim(true), null);
      await ready(first);
      await ready(second);
      await ready(independent);
      await api('POST', '/v2/cases/v2-second/cancel');
      await api('POST', '/v2/cases/v2-independent/cancel');
      await cleaned(second.task.taskId);
      await cleaned(independent.task.taskId);
      node.ignoreClose = true;
      const complete = async (execution: typeof first) => {
        await ready(execution);
        const definition = execution.task;
        const steps = definition.steps.map((s: { stepId: string }) => ({
          stepId: s.stepId,
          status: 'PENDING',
          summary: '等待',
          evidenceRefs: [] as string[],
          criteria: [] as Array<Record<string, unknown>>,
          startedAt: null as string | null,
          finishedAt: null as string | null,
        }));
        let cleanupDeadline: string | undefined;
        for (const [i, state] of steps.entries()) {
          state.status = 'RUNNING';
          state.startedAt = new Date().toISOString();
          state.summary = '执行中';
          const saved = await api(
            'POST',
            `/v1/executions/${execution.id}/steps`,
            steps,
            execution.leaseToken,
          );
          assert.equal(saved.status, 200, JSON.stringify(saved));
          // 两个清理步骤共享一次三分钟签发；重送快照不重新计时，业务阶段维持原期限。
          if (definition.cleanupStepIds.includes(state.stepId)) {
            if (!cleanupDeadline) {
              cleanupDeadline = saved.data.cleanupDeadlineAt;
              assert.ok(Date.parse(cleanupDeadline!) - Date.now() > 179_000);
              assert.ok(Date.parse(cleanupDeadline!) - Date.now() <= 180_000);
              assert.notEqual(cleanupDeadline, execution.taskDeadlineAt);
            }
            assert.equal(saved.data.cleanupDeadlineAt, cleanupDeadline);
            const repeated = await api(
              'POST',
              `/v1/executions/${execution.id}/steps`,
              steps,
              execution.leaseToken,
            );
            assert.equal(repeated.data.cleanupDeadlineAt, cleanupDeadline);
            assert.equal(repeated.data.taskDeadlineAt, cleanupDeadline);
          } else {
            assert.equal(saved.data.cleanupDeadlineAt, null);
            assert.equal(saved.data.taskDeadlineAt, execution.taskDeadlineAt);
          }

          await command(execution, { type: 'browser.observe' });
          const view = (
            await api(
              'GET',
              `/v1/executions/${execution.id}`,
              undefined,
              execution.leaseToken,
            )
          ).data;
          const artifact = view.artifacts
            .filter((a: { kind: string }) => a.kind === 'DOM')
            .at(-1);
          state.status = 'COMPLETED';
          state.finishedAt = new Date().toISOString();
          state.summary = '夹具完成';
          state.evidenceRefs = [artifact.id];
          state.criteria = definition.acceptanceCriteria
            .filter(
              (c: { stepId: string }) =>
                c.stepId === definition.steps[i].stepId,
            )
            .map((c: { id: string }) => ({
              criterionId: c.id,
              verdict: 'PASSED',
              summary: '夹具结论',
              evidenceRefs: [artifact.id],
            }));
          assert.equal(
            (
              await api(
                'POST',
                `/v1/executions/${execution.id}/steps`,
                steps,
                execution.leaseToken,
              )
            ).status,
            200,
          );
          const forged = structuredClone(steps);
          forged[i].evidenceRefs = ['foreign-artifact'];
          assert.equal(
            (
              await api(
                'POST',
                `/v1/executions/${execution.id}/steps`,
                forged,
                execution.leaseToken,
              )
            ).status,
            422,
          );
        }
        const view = (
          await api(
            'GET',
            `/v1/executions/${execution.id}`,
            undefined,
            execution.leaseToken,
          )
        ).data;
        const report = {
          protocolVersion: '0.1',
          taskId: definition.taskId,
          lifecycle: 'COMPLETED',
          executionDisposition: 'EXECUTED',
          verdict: 'PASSED',
          summary: '夹具报告',
          criteria: steps.flatMap((s: { criteria: unknown[] }) => s.criteria),
          steps,
          artifacts: view.artifacts.map(
            (a: { id: string; kind: string; sha256: string }) => ({
              id: a.id,
              kind: a.kind,
              sha256: a.sha256,
              uri: `${base}/v1/artifacts/${a.id}`,
            }),
          ),
        };
        const result = await api(
          'POST',
          `/v1/executions/${execution.id}/complete`,
          { type: 'execution.complete', report },
          execution.leaseToken,
        );
        assert.equal(result.status, 200, JSON.stringify(result));
        return report;
      };
      await complete(first);
      assert.equal(
        (await api('GET', '/v2/cases/v2-first')).data.cleanup.status,
        'COMPLETED',
      );
      assert.equal(await claim(true), null);
      node.ignoreClose = false;
      for (const id of [...node.sessions.keys()]) node.closed(id);
      await cleaned(first.task.taskId);
      const final = (await api('GET', '/v2/cases/v2-first')).data;
      assert(
        validateCaseResultV2(final),
        JSON.stringify(validateCaseResultV2.errors),
      );
      assert.equal(final.result!.outcome, 'PASSED');
      assert.equal(final.cleanup!.result!.outcome, 'PASSED');
      assert.equal(final.cleanup!.taskId, first.task.taskId);
      assert.equal(final.steps.at(-1)!.stepId, 'cleanup-2');
      assert.equal(await claim(true), null);
      assert.equal(
        (
          await api(
            'GET',
            new URL(final.cleanup!.result!.evidence[0]!.url).pathname,
          )
        ).status,
        200,
      );
      await api('POST', '/v2/cases', [
        { ...input, caseId: 'v2-never-executed' },
      ]);
      await api('POST', '/v2/cases/v2-never-executed/cancel');
      await until(
        async () =>
          (await api('GET', '/v2/cases/v2-never-executed')).data.cleanup.status,
        (state) => state === 'SKIPPED',
      );
      await api('POST', `/v1/nodes/${node.id}/revoke`);
      node.close();
    });

    // 范围：真实事务保留部分结论、允许新增证据升级暂存项并拒绝改写确定结论；节点仍为协议夹具，不证明网页验收。
    await suite.test(
      '逐项结果保存后不可丢失，清理受阻不改写业务报告',
      async () => {
        const node = await addNode('case-fixture');
        for (const partial of [true, false]) {
          const caseId = `partial-criteria-${partial}`;
          const url = 'https://criteria.example.test';
          await api('POST', '/v2/cases', [
            {
              caseId,
              platform: '逐项夹具',
              entry: url,
              steps: [1, 2].map((i) => ({
                type: 'verification',
                url,
                exec_order: i,
                description: '逐项检查',
                policy: [],
                expected: i === 1 ? ['A', 'B'] : ['C'],
              })),
              cleanup: [
                { url, exec_order: 1, description: '清除 NEXT_LOCALE Cookie' },
              ],
            },
          ]);
          const execution = await until(
            () => claim(true),
            (value) => !!value,
          );
          await ready(execution);
          const path = `/v1/executions/${execution.id}`;
          const steps = execution.task.steps.map(
            (step: { stepId: string }) => ({
              stepId: step.stepId,
              status: 'PENDING',
              summary: '等待',
              evidenceRefs: [] as string[],
              criteria: [] as any[],
              requirements: [] as any[],
              startedAt: null as string | null,
              finishedAt: null as string | null,
            }),
          );
          const save = (body = steps) =>
            api('POST', `${path}/steps`, body, execution.leaseToken);
          for (const [i, state] of steps.entries()) {
            state.status = 'RUNNING';
            state.startedAt = new Date().toISOString();
            assert.equal((await save()).status, 200);
            const clearRequest = {
              type: 'execution.command',
              commandId: randomUUID(),
              timeoutMs: 15000,
              command: {
                type: 'browser.cookies.clear',
                url,
                names: ['NEXT_LOCALE'],
              },
            };
            if (i === 0) {
              assert.equal(
                (
                  await api(
                    'POST',
                    `${path}/commands`,
                    clearRequest,
                    execution.leaseToken,
                  )
                ).data.code,
                'COOKIE_CLEANUP_FORBIDDEN',
              );
            }
            if (i === 2) {
              node.cookieCleanup = false;
              node.heartbeat();
              await until(
                async () =>
                  (
                    await sql.query(
                      'SELECT capabilities FROM pr_nodes WHERE id=$1',
                      [node.id],
                    )
                  ).rows[0].capabilities.cookieCleanup,
                (value) => value === false,
              );
              assert.equal(
                (
                  await api(
                    'POST',
                    `${path}/commands`,
                    clearRequest,
                    execution.leaseToken,
                  )
                ).data.code,
                'COOKIE_CLEANUP_UNSUPPORTED',
              );
              node.cookieCleanup = true;
              node.heartbeat();
              await until(
                async () =>
                  (
                    await sql.query(
                      'SELECT capabilities FROM pr_nodes WHERE id=$1',
                      [node.id],
                    )
                  ).rows[0].capabilities.cookieCleanup,
                (value) => value === true,
              );
              await command(execution, clearRequest.command);
              assert.equal(
                (await api('GET', path, undefined, execution.leaseToken)).data
                  .actionCount,
                1,
              );
            }
            await command(execution, { type: 'browser.observe' });
            const view = (
              await api('GET', path, undefined, execution.leaseToken)
            ).data;
            const artifact = view.artifacts.at(-1);
            state.criteria = execution.task.acceptanceCriteria
              .filter((c: any) => c.stepId === state.stepId)
              .map((c: any) => ({
                criterionId: c.id,
                verdict: 'PASSED',
                summary: '已观察并保存',
                evidenceRefs: [artifact.id],
              }));
            if (i === 0 && partial) state.criteria.pop();
            if (i === 0 && !partial) state.criteria[1].verdict = 'INCONCLUSIVE';
            state.evidenceRefs = [artifact.id];
            state.requirements = [
              {
                id: 'r1',
                status: 'recorded',
                summary: '原始要求已有证据',
                evidenceRefs: [artifact.id],
              },
            ];
            assert.equal((await save()).status, 200);
            // 范围：要求进度持久化、唯一身份和证据归属；不判断模型声明的业务真实性。
            const persistedRequirements = (
              await api('GET', `/v1/tasks/${execution.task.taskId}`)
            ).data;
            assert.deepEqual(
              persistedRequirements.stepResults[i].requirements,
              state.requirements,
            );
            for (const invalid of [
              [...state.requirements, ...state.requirements],
              [{ ...state.requirements[0], evidenceRefs: [] }],
              [{ ...state.requirements[0], evidenceRefs: [randomUUID()] }],
            ]) {
              const rejected = structuredClone(steps);
              rejected[i].requirements = invalid;
              assert.equal((await save(rejected)).status, 422);
            }
            if (i === 0) {
              const lost = structuredClone(steps);
              lost[0].criteria = [];
              assert.equal((await save(lost)).status, 422);
              const overwritten = structuredClone(steps);
              overwritten[0].criteria[0].summary = '改写原结论';
              assert.equal((await save(overwritten)).status, 422);
              const persisted = (
                await api('GET', `/v1/tasks/${execution.task.taskId}`)
              ).data;
              assert.deepEqual(
                persisted.stepResults[0].criteria,
                state.criteria,
              );
              if (!partial) {
                const unsupported = structuredClone(steps);
                unsupported[0].criteria[1].verdict = 'PASSED';
                assert.equal((await save(unsupported)).status, 422);
                await command(execution, { type: 'browser.observe' });
                const supplemented = (
                  await api('GET', path, undefined, execution.leaseToken)
                ).data.artifacts.at(-1);
                state.criteria[1] = {
                  ...state.criteria[1],
                  verdict: 'PASSED',
                  summary: '补证后覆盖完整',
                  evidenceRefs: [artifact.id, supplemented.id],
                };
                state.evidenceRefs.push(supplemented.id);
                assert.equal((await save()).status, 200);
                const saved = (
                  await api('GET', `/v1/tasks/${execution.task.taskId}`)
                ).data;
                assert.deepEqual(saved.stepResults[0].criteria, state.criteria);
              }
            }
            state.status =
              i === 2 || (partial && i === 0) ? 'BLOCKED' : 'COMPLETED';
            state.finishedAt = new Date().toISOString();
            assert.equal((await save()).status, 200);
          }
          const view = (await api('GET', path, undefined, execution.leaseToken))
            .data;
          const recorded = steps.flatMap((s: any) => s.criteria);
          const criteria = execution.task.acceptanceCriteria.map(
            (c: any) =>
              recorded.find((r: any) => r.criterionId === c.id) ?? {
                criterionId: c.id,
                verdict: 'SKIPPED',
                summary: '尚未完成',
                evidenceRefs: [],
              },
          );
          const report = {
            protocolVersion: '0.1',
            taskId: execution.task.taskId,
            lifecycle: 'COMPLETED',
            executionDisposition: partial ? 'BLOCKED' : 'EXECUTED',
            verdict: partial ? null : 'PASSED',
            summary: '夹具报告',
            criteria,
            steps,
            artifacts: view.artifacts.map((a: any) => ({
              id: a.id,
              kind: a.kind,
              sha256: a.sha256,
              uri: `${base}/v1/artifacts/${a.id}`,
            })),
          };
          const completed = await api(
            'POST',
            `${path}/complete`,
            { type: 'execution.complete', report },
            execution.leaseToken,
          );
          assert.equal(completed.status, 200, JSON.stringify(completed));
          await cleaned(execution.task.taskId);
          const result = (
            await api('GET', `/v1/tasks/${execution.task.taskId}`)
          ).data.report;
          assert.deepEqual(result.criteria, criteria);
          assert.equal(
            result.executionDisposition,
            report.executionDisposition,
          );
        }
        await api('POST', `/v1/nodes/${node.id}/revoke`);
        node.close();
      },
    );

    // 范围：真实 HTTP/PostgreSQL 独立计数、幂等、耗尽推进和人工暂停；节点/模型结果为夹具，不验证网页行为。
    await suite.test(
      '逐步额度由服务端隔离，模型动作时间耗尽均允许下一步',
      async () => {
        const node = await addNode('case-fixture');
        const caseId = 'step-budget-isolation';
        const step = {
          type: 'verification',
          url: 'https://budget.example.test',
          exec_order: 1,
          description: '预算夹具',
          policy: [],
          expected: ['夹具结果'],
        };
        await api('POST', '/v2/cases', [
          {
            caseId,
            platform: '预算夹具',
            entry: step.url,
            steps: [
              step,
              { ...step, exec_order: 2 },
              { ...step, exec_order: 3 },
            ],
            cleanup: [{ url: step.url, exec_order: 1, description: '收尾' }],
          },
        ]);
        // 缩小冻结的测试额度，避免为边界测试制造大量请求；生产定义不作修改。
        const stored = (
          await sql.query('SELECT definition FROM pr_tasks WHERE id=$1', [
            `case-v2-${caseId}`,
          ])
        ).rows[0].definition;
        stored.environment.allowIntervention = true;
        for (const budget of stored.stepBudget.steps) {
          budget.maxActions = 1;
          budget.maxModelCalls = 1;
        }
        await sql.query('UPDATE pr_tasks SET definition=$2 WHERE id=$1', [
          stored.taskId,
          stored,
        ]);
        const oldWorker = await api(
          'POST',
          '/v1/worker/claim',
          {
            type: 'worker.claim',
            workerId: randomUUID(),
            structuredSteps: true,
          },
          WORKER,
        );
        assert.equal(oldWorker.data.execution, null);
        const execution = await claim(true);
        await ready(execution);
        const workerPath = `/v1/executions/${execution.id}`;
        const adminPath = `/v1/admin/executions/${execution.id}`;
        const results = execution.task.steps.map(
          (step: { stepId: string }) => ({
            stepId: step.stepId,
            status: 'PENDING',
            summary: '夹具',
            criteria: [],
            evidenceRefs: [],
            startedAt: null as string | null,
            finishedAt: null as string | null,
          }),
        );
        const start = async (index: number) => {
          if (index > 0) {
            results[index - 1].status = 'BLOCKED';
            results[index - 1].finishedAt = new Date().toISOString();
          }
          results[index].status = 'RUNNING';
          results[index].startedAt = new Date().toISOString();
          const saved = await api(
            'POST',
            `${workerPath}/steps`,
            results,
            execution.leaseToken,
          );
          assert.equal(saved.status, 200, JSON.stringify(saved));
          return saved.data;
        };
        await start(0);
        const first = await command(execution, {
          type: 'browser.act',
          action: 'navigate',
          target: step.url,
        });
        // 原命令重送不会二次扣款；新命令耗尽只拒绝本步。
        assert.equal(
          (
            await api(
              'POST',
              `${workerPath}/commands`,
              first.request,
              execution.leaseToken,
            )
          ).status,
          202,
        );
        const rejected = await api(
          'POST',
          `${workerPath}/commands`,
          { ...first.request, commandId: randomUUID() },
          execution.leaseToken,
        );
        assert.equal(rejected.data.code, 'STEP_ACTION_BUDGET_EXCEEDED');
        await start(1);
        await command(execution, {
          type: 'browser.act',
          action: 'navigate',
          target: step.url,
        });
        const callId = randomUUID();
        const request = {
          phase: 'start',
          record: {
            id: callId,
            callIndex: 201,
            decisionIndex: 201,
            model: 'fixture',
            purpose: 'DECISION',
            startedAt: new Date().toISOString(),
            finishedAt: null,
            status: 'PENDING',
            request: '{"model":"fixture","messages":[]}',
            requestSha256: 'a'.repeat(64),
            response: null,
            error: null,
            promptTokens: null,
            completionTokens: null,
            elapsedMs: null,
            imagesOmitted: 0,
            archived: false,
          },
        };
        assert.equal(
          (
            await api(
              'POST',
              `${workerPath}/model-calls/${callId}`,
              request,
              execution.leaseToken,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await api(
              'POST',
              `${workerPath}/model-calls/${callId}`,
              request,
              execution.leaseToken,
            )
          ).status,
          200,
        );
        const extraId = randomUUID();
        const extra = await api(
          'POST',
          `${workerPath}/model-calls/${extraId}`,
          {
            ...request,
            record: { ...request.record, id: extraId, callIndex: 202 },
          },
          execution.leaseToken,
        );
        assert.equal(extra.data.code, 'STEP_MODEL_BUDGET_EXCEEDED');
        await api(
          'POST',
          `${workerPath}/model-calls/${callId}`,
          {
            phase: 'finish',
            result: {
              finishedAt: new Date().toISOString(),
              status: 'ERROR',
              response: null,
              error: 'FIXTURE_FAILURE',
              promptTokens: null,
              completionTokens: null,
              elapsedMs: 1,
            },
          },
          execution.leaseToken,
        );
        await start(2);
        const before = (
          await api('GET', workerPath, undefined, execution.leaseToken)
        ).data;
        await api('POST', `${adminPath}/intervene`, {
          type: 'execution.intervene',
          controlRevision: 0,
          reason: '夹具暂停',
        });
        await api(
          'POST',
          `${workerPath}/control`,
          {
            type: 'execution.control',
            action: 'acknowledge',
            controlRevision: 1,
          },
          execution.leaseToken,
        );
        await delay(30);
        const resume = await api('POST', `${adminPath}/control`, {
          type: 'execution.control',
          action: 'resume',
          controlRevision: 1,
        });
        assert.equal(resume.status, 200, JSON.stringify(resume));
        const after = (
          await api('GET', workerPath, undefined, execution.leaseToken)
        ).data;
        assert(
          after.stepBudget.deadlineAt >= before.stepBudget.deadlineAt + 25,
        );
        assert(
          after.stepBudget.deadlineAt - before.stepBudget.deadlineAt < 3000,
        );
        assert.equal(after.stepBudget.modelCalls, 0);
        // 服务端计时到期，但整个任务仍保持授权，后续清理可取得独立额度。
        await sql.query(
          "UPDATE pr_executions SET budget_state=jsonb_set(jsonb_set(budget_state,'{deadlineAt}',to_jsonb(0)),ARRAY['steps',budget_state->>'stepId','deadlineAt'],to_jsonb(0)) WHERE id=$1",
          [execution.id],
        );
        const timed = await api(
          'POST',
          `${workerPath}/commands`,
          {
            type: 'execution.command',
            commandId: randomUUID(),
            controlRevision: 2,
            timeoutMs: 1000,
            command: { type: 'browser.observe' },
          },
          execution.leaseToken,
        );
        assert.equal(timed.data.code, 'STEP_TIME_BUDGET_EXCEEDED');
        const cleanup = await start(3);
        assert.equal(cleanup.stepBudget.actions, 0);
        assert.equal(cleanup.stepBudget.modelCalls, 0);
        assert(cleanup.stepBudget.deadlineAt - Date.now() > 179_000);
        const cleanupAction = await api(
          'POST',
          `${workerPath}/commands`,
          {
            type: 'execution.command',
            commandId: randomUUID(),
            controlRevision: 2,
            timeoutMs: 1000,
            command: {
              type: 'browser.act',
              action: 'navigate',
              target: step.url,
            },
          },
          execution.leaseToken,
        );
        assert.equal(cleanupAction.status, 202, JSON.stringify(cleanupAction));
        await api('POST', `/v2/cases/${caseId}/cancel`);
        await cleaned(execution.task.taskId);
        await api('POST', `/v1/nodes/${node.id}/revoke`);
        node.close();
      },
    );

    // 范围：数据库持久化清理期限并在人工模式下强制到期；缩短数据库期限替代真实三分钟等待，不验证网页清理效果。
    await suite.test('清理独立期限到期后撤权，不受人工暂停影响', async () => {
      const node = await addNode('case-fixture');
      const caseId = 'cleanup-clock';
      await api('POST', '/v2/cases', [
        {
          caseId,
          platform: '清理时钟夹具',
          entry: 'https://cleanup-clock.example.test',
          steps: [
            {
              type: 'verification',
              url: 'https://cleanup-clock.example.test',
              exec_order: 1,
              description: '检查',
              policy: [],
              expected: ['预期'],
            },
          ],
          cleanup: [
            {
              url: 'https://cleanup-clock.example.test',
              exec_order: 1,
              description: '清理',
            },
          ],
        },
      ]);
      const execution = await claim(true);
      await ready(execution);
      const results = execution.task.steps.map(
        (step: { stepId: string }, index: number) => ({
          stepId: step.stepId,
          status: index === 0 ? 'BLOCKED' : 'RUNNING',
          summary: '夹具',
          criteria: [],
          evidenceRefs: [],
          startedAt: new Date().toISOString(),
          finishedAt: index === 0 ? new Date().toISOString() : null,
        }),
      );
      const saved = await api(
        'POST',
        `/v1/executions/${execution.id}/steps`,
        results,
        execution.leaseToken,
      );
      assert.equal(saved.status, 200, JSON.stringify(saved));
      const stored = (
        await sql.query(
          'SELECT cleanup_deadline_at,deadline_at FROM pr_tasks WHERE id=$1',
          [execution.task.taskId],
        )
      ).rows[0];
      assert.equal(
        stored.cleanup_deadline_at.toISOString(),
        saved.data.cleanupDeadlineAt,
      );
      await sql.query(
        "UPDATE pr_executions SET control_mode='HUMAN' WHERE id=$1",
        [execution.id],
      );
      await sql.query(
        "UPDATE pr_tasks SET cleanup_deadline_at=clock_timestamp()-interval '1 second',deadline_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
        [execution.task.taskId],
      );
      await until(
        async () =>
          (await api('GET', `/v1/tasks/${execution.task.taskId}`)).data.state,
        (state) => state === 'TIMED_OUT',
      );
      const detail = (await api('GET', `/v1/tasks/${execution.task.taskId}`))
        .data;
      assert.equal(detail.error.code, 'CLEANUP_DEADLINE_EXCEEDED');
      assert.equal(
        (
          await api(
            'POST',
            `/v1/executions/${execution.id}/steps`,
            results,
            execution.leaseToken,
          )
        ).status,
        409,
      );
      await cleaned(execution.task.taskId);
      await api('POST', `/v1/nodes/${node.id}/revoke`);
      node.close();
    });

    // 范围：真实 HTTP、数据库和调度器验证未知写入撤权不另起清理、不阻塞新 case、幂等重提不重跑；导航故障由节点夹具注入，不证明网络或浏览器行为。
    await suite.test('v2 未知写入终止同任务清理，新任务仍可领取', async () => {
      const node = await addNode('case-fixture', 2);
      const input = {
        caseId: 'v2-failed-cleanup',
        platform: '清理故障夹具',
        entry: 'https://cleanup.example.test',
        steps: [
          {
            type: 'verification',
            url: 'https://cleanup.example.test',
            exec_order: 1,
            description: '检查页面',
            policy: [],
            expected: ['页面可访问'],
          },
        ],
        cleanup: [
          {
            url: 'https://cleanup.example.test',
            exec_order: 1,
            description: '恢复明确指定的测试值',
          },
        ],
      };
      assert.equal((await api('POST', '/v2/cases', [input])).status, 202);
      const first = await claim(true);
      await ready(first);
      await api(
        'POST',
        `/v1/executions/${first.id}/steps`,
        first.task.steps.map((step: { stepId: string }, index: number) => ({
          stepId: step.stepId,
          status: index === 0 ? 'RUNNING' : 'PENDING',
          summary: '夹具',
          criteria: [],
          evidenceRefs: [],
          startedAt: index === 0 ? new Date().toISOString() : null,
          finishedAt: null,
        })),
        first.leaseToken,
      );
      node.unknownWrite = true;
      await command(first, {
        type: 'browser.act',
        action: 'navigate',
        target: input.entry,
      });
      await cleaned(first.task.taskId);
      assert.equal(await claim(true), null);
      const failed = (await api('GET', `/v2/cases/${input.caseId}`)).data;
      assert.equal(failed.status, 'ERROR');
      assert.equal(failed.cleanup.status, 'SKIPPED');

      const repeated = await api('POST', '/v2/cases', [input]);
      assert.equal(repeated.status, 202);
      assert.equal(repeated.data[0].status, 'ERROR');
      assert.equal(repeated.data[0].cleanup.status, 'SKIPPED');
      assert.equal(await claim(true), null);

      node.unknownWrite = false;
      const next = { ...input, caseId: 'v2-after-failed-cleanup', cleanup: [] };
      assert.equal((await api('POST', '/v2/cases', [next])).status, 202);
      const execution = await claim(true);
      assert.ok(execution, '旧清理失败不能阻塞新的 caseId');
      assert.equal(execution.task.taskId, `case-v2-${next.caseId}`);
      assert.equal(execution.task.resourceKey, undefined);
      assert.equal(first.task.resourceKey, undefined);
      assert.equal(
        (await api('GET', `/v2/cases/${input.caseId}`)).data.cleanup.status,
        'SKIPPED',
      );
      await api('POST', `/v2/cases/${next.caseId}/cancel`);
      await cleaned(execution.task.taskId);
      await api('POST', `/v1/nodes/${node.id}/revoke`);
      node.close();
    });

    // 范围：历史独立清理的主任务终态、关闭回执、原节点归属及跨 case 独立；数据库构造旧版记录，节点不执行业务浏览器。
    await suite.test('公开 case 入口只接收业务概念并隐藏平台配置', async () => {
      const input = {
        caseId: 'case-http-fixture',
        description: '验证通知默认开启',
        url: 'https://app.example.test/settings',
        acceptanceCriteria: [
          { id: 'enabled', description: '通知开关', expectedResult: '开启' },
        ],
      };
      assert.equal((await api('POST', '/v1/cases', input, WORKER)).status, 401);
      const { url: _, ...missingUrl } = input;
      assert.equal((await api('POST', '/v1/cases', missingUrl)).status, 400);
      assert.equal(
        (await api('POST', '/v1/cases', { ...input, environment: {} })).status,
        400,
      );
      const results = await Promise.all([
        api('POST', '/v1/cases', input),
        api('POST', '/v1/cases', input),
      ]);
      for (const response of results) {
        assert.equal(response.status, 202);
        assert(validateCaseResult(response.data));
        assert.deepEqual(response.data, {
          caseId: input.caseId,
          status: 'QUEUED',
          queueReason: null,
          reportStatus: null,
          criteriaCounts: null,
          result: null,
        });
      }
      const rows = (
        await sql.query('SELECT definition FROM pr_tasks WHERE id=$1', [
          `case-${input.caseId}`,
        ])
      ).rows;
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].definition.caseDefinition, input);
      assert.equal(rows[0].definition.target.url, input.url);
      assert.equal(rows[0].definition.objective, input.description);
      assert.deepEqual(
        rows[0].definition.environment,
        config.caseProfile.environment,
      );
      assert.equal(
        (await api('POST', '/v1/cases', { ...input, description: '另一目标' }))
          .status,
        409,
      );
      assert.equal((await api('GET', `/v1/cases/${input.caseId}`)).status, 200);
      assert.equal(
        (
          await api('POST', '/v1/cases', {
            ...input,
            url: 'https://another.example.test',
          })
        ).status,
        409,
      );
      assert.equal(
        (await api('GET', `/v1/cases/${input.caseId}/evidence/unrelated`))
          .status,
        404,
      );
      assert.equal(
        (await api('POST', `/v1/cases/${input.caseId}/cancel`)).data.status,
        'CANCELLED',
      );
      assert.equal(
        (await api('POST', '/v1/cases', input)).data.status,
        'CANCELLED',
      );
    });
    // 范围：case 经真实队列、worker 协议与证据下载闭环；节点和报告为夹具，不证明真实浏览器业务通过。
    await suite.test(
      'case 经内部执行协议交付结果且证据不能跨 case 读取',
      async () => {
        await addNode(config.caseProfile.environment.nodePool);
        const input = {
          caseId: 'case-result-fixture',
          description: '观察页面',
          url: 'https://app.example.test/view',
          acceptanceCriteria: [
            {
              id: 'observed',
              description: '观察页面内容',
              expectedResult: '取得页面事实',
            },
          ],
        };
        assert.equal((await api('POST', '/v1/cases', input)).status, 202);
        const execution = await claim();
        assert(validateExecutionGrant(execution));
        assert.equal(execution.task.caseDefinition!.caseId, input.caseId);
        assert.equal(execution.task.target.url, input.url);
        await ready(execution);
        const { result } = await command(execution, {
          type: 'browser.observe',
          screenshot: false,
        });
        const refs = result.data.artifactRefs as Array<{
          artifactId: string;
          kind: string;
          sha256: string;
        }>;
        const report = {
          protocolVersion: '0.1',
          taskId: execution.task.taskId,
          lifecycle: 'COMPLETED',
          executionDisposition: 'EXECUTED',
          verdict: 'PASSED',
          summary: '夹具证据已交付',
          criteria: [
            {
              criterionId: 'observed',
              verdict: 'PASSED',
              summary: '夹具观察已登记',
              evidenceRefs: refs.map((r) => r.artifactId),
            },
          ],
          artifacts: refs.map((r) => ({
            id: r.artifactId,
            kind: r.kind,
            sha256: r.sha256,
            uri: 'https://internal.example.test/unused',
          })),
        };
        assert.equal(
          (
            await api(
              'POST',
              `/v1/executions/${execution.id}/complete`,
              { type: 'execution.complete', report },
              execution.leaseToken,
            )
          ).status,
          200,
        );
        const response = await api('GET', `/v1/cases/${input.caseId}`);
        assert(validateCaseResult(response.data));
        assert.equal(response.data.result!.outcome, 'PASSED');
        assert(!JSON.stringify(response.data).includes('private-'));
        for (const artifact of response.data.result!.evidence) {
          assert.equal(
            new URL(artifact.url).pathname,
            `/v1/cases/${input.caseId}/evidence/${artifact.id}`,
          );
          const download = await fetch(artifact.url, {
            headers: { authorization: `Bearer ${ADMIN}` },
          });
          assert.equal(download.status, 200);
          assert.equal(
            createHash('sha256')
              .update(Buffer.from(await download.arrayBuffer()))
              .digest('hex'),
            artifact.sha256,
          );
          assert.equal(
            (
              await api(
                'GET',
                `/v1/cases/case-http-fixture/evidence/${artifact.id}`,
              )
            ).status,
            404,
          );
        }
        assert(response.data.result!.evidence.length > 0);
        await cleaned(execution.task.taskId);
      },
    );

    // 范围：真实接口、持久库、配置冲突及跨池隔离；节点是协议夹具，不验证真实 VM 网络可达性。
    await suite.test('执行节点域名配置校验、权限与原子更新', async () => {
      const a = await addNode('domain-config');
      const b = await addNode('domain-config');
      const other = await addNode('domain-other');
      const path = `/v1/nodes/${a.id}/routing`;
      assert.equal(
        (await api('POST', path, { domains: [], revision: 0 }, WORKER)).status,
        401,
      );
      assert.equal(
        (
          await api('POST', path, {
            domains: ['https://example.com'],
            revision: 0,
          })
        ).status,
        400,
      );
      assert.equal(
        (await api('POST', path, { domains: [], revision: 0, extra: true }))
          .status,
        400,
      );
      const saved = await api('POST', path, {
        domains: ['EXAMPLE.COM.', 'example.com', '例子.测试'],
        revision: 0,
      });
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.data, {
        domains: ['example.com', 'xn--fsqu00a.xn--0zwm56d'],
        revision: 1,
      });
      assert.equal(
        (await api('POST', path, { domains: [], revision: 0 })).data.code,
        'ROUTING_CHANGED',
      );
      assert.equal(
        (
          await api('POST', `/v1/nodes/${b.id}/routing`, {
            domains: ['other.example', 'example.com'],
            revision: 0,
          })
        ).data.code,
        'DOMAIN_ASSIGNED',
      );
      const rows = (await api('GET', '/v1/nodes')).data.nodes;
      assert.deepEqual(
        rows.find((n: { id: string }) => n.id === b.id).routing_domains,
        [],
      );
      assert.deepEqual(
        rows.find((n: { id: string }) => n.id === a.id).routing_domains,
        saved.data.domains,
      );
      assert.equal(
        (
          await api('POST', `/v1/nodes/${other.id}/routing`, {
            domains: ['example.com'],
            revision: 0,
          })
        ).status,
        200,
      );
      const concurrent = await Promise.all(
        [a, b].map((n) =>
          api('POST', `/v1/nodes/${n.id}/routing`, {
            domains: ['race.example'],
            revision: n === a ? 1 : 0,
          }),
        ),
      );
      assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
      await api('POST', `/v1/nodes/${other.id}/revoke`);
      assert.equal(
        (
          await api('POST', `/v1/nodes/${other.id}/routing`, {
            domains: ['new.example'],
            revision: 1,
          })
        ).data.code,
        'NODE_REVOKED',
      );
      assert.equal(
        (
          await api('POST', `/v1/nodes/${other.id}/routing`, {
            domains: [],
            revision: 1,
          })
        ).status,
        200,
      );
    });

    // 范围：真实 HTTP 与数据库验证通配规则归一化、原子冲突和跨池复用；不验证真实 DNS 或浏览器。
    await suite.test('通配域名配置持久化与冲突保持原子性', async () => {
      const owner = await addNode('wildcard-config');
      const other = await addNode('wildcard-config');
      const separate = await addNode('wildcard-config-other');
      const saved = await api('POST', `/v1/nodes/${owner.id}/routing`, {
        domains: ['*.EXAMPLE.COM.', '*.example.com', '*.例子.测试'],
        revision: 0,
      });
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.data.domains, [
        '*.example.com',
        '*.xn--fsqu00a.xn--0zwm56d',
      ]);
      assert.equal(
        (
          await api('POST', `/v1/nodes/${other.id}/routing`, {
            domains: ['existing.example'],
            revision: 0,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await api('POST', `/v1/nodes/${other.id}/routing`, {
            domains: ['new.example', '*.EXAMPLE.COM.'],
            revision: 1,
          })
        ).data.code,
        'DOMAIN_ASSIGNED',
      );
      assert.equal(
        (
          await api('POST', `/v1/nodes/${other.id}/routing`, {
            domains: ['new.example', 'a.*.example.com'],
            revision: 1,
          })
        ).status,
        400,
      );
      const rows = (await api('GET', '/v1/nodes')).data.nodes;
      assert.deepEqual(
        rows.find((n: { id: string }) => n.id === owner.id).routing_domains,
        saved.data.domains,
      );
      const unchanged = rows.find((n: { id: string }) => n.id === other.id);
      assert.deepEqual(unchanged.routing_domains, ['existing.example']);
      assert.equal(unchanged.routing_revision, 1);
      assert.equal(
        (
          await api('POST', `/v1/nodes/${separate.id}/routing`, {
            domains: ['*.example.com'],
            revision: 0,
          })
        ).status,
        200,
      );
    });

    // 范围：真实领取事务验证重叠规则优先级和满载时不回退；节点协议由夹具模拟，不运行 Chrome。
    await suite.test(
      '通配域名调度优先精确和更具体规则，满载不回退',
      async () => {
        const broad = await addNode('wildcard-schedule');
        const narrow = await addNode('wildcard-schedule');
        const exact = await addNode('wildcard-schedule');
        for (const [node, domain] of [
          [broad, '*.example.com'],
          [narrow, '*.team.example.com'],
          [exact, 'app.team.example.com'],
        ] as const) {
          assert.equal(
            (
              await api('POST', `/v1/nodes/${node.id}/routing`, {
                domains: [domain],
                revision: 0,
              })
            ).status,
            200,
          );
        }
        for (const [hostname, node] of [
          ['app.team.example.com', exact],
          ['deep.app.team.example.com', narrow],
          ['team.example.com', broad],
        ] as const) {
          const first = task(broad.pool);
          first.target.url = `https://${hostname}`;
          await submit(first);
          const execution = await claim();
          assert.equal(execution.nodeId, node.id);
          await ready(execution);
          const queued = task(broad.pool);
          queued.target.url = first.target.url;
          await submit(queued);
          assert.equal(await claim(), null);
          await api('POST', `/v1/tasks/${queued.taskId}/cancel`);
          await api('POST', `/v1/tasks/${first.taskId}/cancel`);
          await cleaned(first.taskId);
          await until(
            async () =>
              (await api('GET', '/v1/nodes')).data.nodes.find(
                (n: { id: string }) => n.id === node.id,
              ).occupied,
            (occupied) => occupied === 0,
          );
        }
      },
    );

    // 范围：真实调度事务的精确绑定、满载等待、未命中回退及修改不迁移活动会话；不运行 Chrome。
    await suite.test('域名绑定固定节点并遵循节点准入声明', async () => {
      const spare = await addNode('domain-schedule');
      const target = await addNode('domain-schedule');
      await api('POST', `/v1/nodes/${target.id}/routing`, {
        domains: ['app.example'],
        revision: 0,
      });
      const first = task('domain-schedule');
      first.target.url = 'https://APP.EXAMPLE.:8443/path';
      await submit(first);
      const execution = await claim();
      assert.equal(execution.nodeId, target.id);
      await ready(execution);
      const queued = task('domain-schedule');
      queued.target.url = 'http://app.example/next';
      await submit(queued);
      assert.equal(await claim(), null);
      const fallback = task('domain-schedule');
      fallback.target.url = 'https://sub.app.example';
      await submit(fallback);
      const free = await claim();
      assert.equal(free.task.taskId, fallback.taskId);
      assert.equal(free.nodeId, spare.id);
      await ready(free);
      await api('POST', `/v1/tasks/${fallback.taskId}/cancel`);
      await cleaned(fallback.taskId);
      await until(
        async () =>
          (await api('GET', '/v1/nodes')).data.nodes.find(
            (n: { id: string }) => n.id === spare.id,
          ).occupied,
        (n) => n === 0,
      );
      await api('POST', `/v1/nodes/${target.id}/routing`, {
        domains: [],
        revision: 1,
      });
      await api('POST', `/v1/nodes/${spare.id}/routing`, {
        domains: ['app.example'],
        revision: 0,
      });
      assert.equal(
        (await api('GET', `/v1/tasks/${first.taskId}`)).data.executions[0]
          .node_id,
        target.id,
      );
      const reassigned = await claim();
      assert.equal(reassigned.task.taskId, queued.taskId);
      assert.equal(reassigned.nodeId, spare.id);
      for (const definition of [first, queued]) {
        await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
        await cleaned(definition.taskId);
      }
    });

    // 范围：通配绑定在离线、撤销、能力缺失和登录归属冲突时不回退到更宽泛规则；等待截止由真实 API 扫描，浏览器是夹具。
    await suite.test('域名目标不可用或与登录节点冲突时保留排队', async () => {
      const spare = await addNode('domain-unavailable');
      const target = await addNode('domain-unavailable');
      spare.authState = true;
      target.authState = true;
      spare.heartbeat();
      target.heartbeat();
      await until(
        async () =>
          (await api('GET', '/v1/nodes')).data.nodes.filter(
            (n: { pool: string }) => n.pool === target.pool,
          ),
        (rows) =>
          rows.every(
            (n: { capabilities: { authState: boolean } }) =>
              n.capabilities.authState,
          ),
      );
      await api('POST', `/v1/nodes/${spare.id}/routing`, {
        domains: ['*.example'],
        revision: 0,
      });
      await api('POST', `/v1/nodes/${target.id}/routing`, {
        domains: ['*.private.example'],
        revision: 0,
      });
      const definition = {
        ...task(target.pool),
        environment: {
          id: 'fixture',
          nodePool: target.pool,
          auth: { nodeId: spare.id, stateId: 'login', restore: false },
        },
        target: { url: 'https://app.private.example' },
      };
      await submit(definition);
      assert.equal(await claim(), null);
      const blocked = (await api('GET', `/v1/tasks/${definition.taskId}`)).data;
      assert.equal(blocked.queueReason.code, 'AUTH_NODE_ROUTE_CONFLICT');
      assert.deepEqual(blocked.executions, []);
      // 仅缩短测试库中的截止时间，验证真实过期循环保留原因；不等待生产预算。
      await sql.query(
        'UPDATE pr_tasks SET deadline_at=clock_timestamp() WHERE id=$1',
        [definition.taskId],
      );
      const timedOut = await until(
        async () => (await api('GET', `/v1/tasks/${definition.taskId}`)).data,
        (value) => value.state === 'TIMED_OUT',
      );
      assert.deepEqual(timedOut.queueReason, blocked.queueReason);
      assert.equal(timedOut.error.code, 'TASK_QUEUE_TIMEOUT');
      assert.deepEqual(timedOut.error.queueReason, blocked.queueReason);
      const capabilities = task(target.pool);
      capabilities.target.url = definition.target.url;
      capabilities.acceptanceCriteria[0]!.evidenceKinds = ['TRACE'];
      await submit(capabilities);
      assert.equal(await claim(), null);
      assert.equal(
        (await api('GET', `/v1/tasks/${capabilities.taskId}`)).data.queueReason
          .code,
        'NO_ELIGIBLE_NODE',
      );
      await api('POST', `/v1/tasks/${capabilities.taskId}/cancel`);
      target.close();
      await until(
        async () =>
          (await api('GET', '/v1/nodes')).data.nodes.find(
            (n: { id: string }) => n.id === target.id,
          ).online,
        (online) => !online,
      );
      const waiting = task(target.pool);
      waiting.target.url = definition.target.url;
      await submit(waiting);
      assert.equal(await claim(), null);
      await api('POST', `/v1/nodes/${target.id}/revoke`);
      assert.equal(await claim(), null);
      await api('POST', `/v1/nodes/${target.id}/routing`, {
        domains: [],
        revision: 1,
      });
      const execution = await claim();
      assert.equal(execution.nodeId, spare.id);
      assert.equal(
        (await api('GET', `/v1/tasks/${waiting.taskId}`)).data.queueReason,
        null,
      );
      await api('POST', `/v1/tasks/${waiting.taskId}/cancel`);
      await cleaned(waiting.taskId);
    });

    // 范围：真实数据库微秒游标、同时间排序、字面搜索和权限；不测试真实浏览器或模型质量。
    await suite.test('控制台任务分页与筛选不漏读', async () => {
      assert.equal(
        (await api('GET', '/v1/tasks?limit=2', undefined, WORKER)).status,
        401,
      );
      const ids = ['a', 'b', 'c', 'd', 'e'].map(
        (suffix) => `console-browse-${suffix}`,
      );
      for (const [index, id] of ids.entries()) {
        const definition = {
          ...task('console-unconnected'),
          taskId: id,
          objective:
            index === 3
              ? 'console-browse 100% done'
              : index === 4
                ? 'console-browse 100X done'
                : 'console-browse',
        };
        await submit(definition);
        await sql.query('UPDATE pr_tasks SET created_at=$2 WHERE id=$1', [
          id,
          `2026-09-24T10:00:00.${[123455, 123456, 123456, 123457, 123458][index]}Z`,
        ]);
      }
      const first = (await api('GET', '/v1/tasks?q=console-browse&limit=2'))
        .data;
      assert.deepEqual(
        first.tasks.map((row: { id: string }) => row.id),
        ids.slice(3).reverse(),
      );
      assert.ok(!JSON.stringify(first).includes('definition_hash'));
      assert.ok(!JSON.stringify(first).includes('token_hash'));
      const seen = [...first.tasks.map((row: { id: string }) => row.id)];
      let cursor = first.nextCursor;
      while (cursor) {
        const page = (
          await api(
            'GET',
            `/v1/tasks?q=console-browse&limit=2&cursor=${encodeURIComponent(cursor)}`,
          )
        ).data;
        seen.push(...page.tasks.map((row: { id: string }) => row.id));
        cursor = page.nextCursor;
      }
      assert.deepEqual(seen, [...ids].reverse());
      assert.equal(
        (await api('GET', `/v1/tasks?q=changed&cursor=${first.nextCursor}`))
          .status,
        400,
      );
      for (const query of [
        'limit=0',
        'limit=101',
        'state=PASSED',
        'cursor=broken',
        'reportOnly=yes',
      ])
        assert.equal((await api('GET', `/v1/tasks?${query}`)).status, 400);
      const literal = (await api('GET', '/v1/tasks?q=100%25')).data;
      assert.deepEqual(
        literal.tasks.map((row: { id: string }) => row.id),
        [ids[3]],
      );
      const detail = (await api('GET', `/v1/tasks/${ids[0]}`)).data;
      assert.equal(detail.report, null);
      assert.equal(detail.executions.length, 0);
      assert.equal(
        (await api('GET', '/v1/tasks?q=console-browse&reportOnly=true')).data
          .tasks.length,
        0,
      );
      for (const id of ids) await api('POST', `/v1/tasks/${id}/cancel`);
      assert.equal(
        (await api('GET', '/v1/tasks?q=console-browse&state=CANCELLED')).data
          .tasks.length,
        5,
      );
      assert.equal(
        (await api('GET', '/v1/tasks?q=console-browse&state=QUEUED')).data.tasks
          .length,
        0,
      );
    });

    // 范围：历史存档读取时的状态聚合、列表/详情一致性及证据清理；报告为数据库夹具，不证明业务结论。
    await suite.test('报告列表与详情返回相同状态且不改写历史报告', async () => {
      const definition = {
        ...task('report-unconnected'),
        taskId: 'report-projection-fixture',
      };
      await submit(definition);
      await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
      const before = (await api('GET', `/v1/tasks/${definition.taskId}`)).data;
      assert.equal(before.reportStatus, null);
      const report = {
        protocolVersion: '0.1',
        taskId: definition.taskId,
        lifecycle: 'COMPLETED',
        executionDisposition: 'BLOCKED',
        verdict: null,
        summary: '历史受阻报告夹具',
        criteria: [],
        artifacts: [],
      };
      await sql.query(
        'UPDATE pr_tasks SET report=$2,archived_at=clock_timestamp() WHERE id=$1',
        [definition.taskId, report],
      );
      const detail = (await api('GET', `/v1/tasks/${definition.taskId}`)).data;
      const list = (
        await api(
          'GET',
          '/v1/tasks?q=report-projection-fixture&reportOnly=true',
        )
      ).data;
      assert.equal(
        validateTaskList(list),
        true,
        JSON.stringify(validateTaskList.errors),
      );
      assert.equal(detail.reportStatus, 'INCONCLUSIVE');
      assert.equal(
        detail.criteriaCounts.skipped,
        definition.acceptanceCriteria.length,
      );
      assert.equal(list.tasks[0].reportStatus, detail.reportStatus);
      assert.deepEqual(list.tasks[0].criteriaCounts, detail.criteriaCounts);
      assert.equal(list.tasks[0].archived_at, detail.archived_at);
      assert.deepEqual(detail.report, report);
      assert.equal(list.tasks[0].report_facts, undefined);
      assert.equal(list.tasks[0].criterion_ids, undefined);
    });

    // 范围：列表和详情隔离清理失败，同时保留前置受阻；数据库报告夹具不代表真实清理验收。
    await suite.test(
      '后续清理失败不影响业务结论，列表与详情口径一致',
      async () => {
        const base = task('cleanup-report-unconnected');
        const id = 'cleanup-report-projection';
        await submit({ ...base, taskId: id });
        await api('POST', `/v1/tasks/${id}/cancel`);
        const definition = {
          ...base,
          taskId: id,
          cleanupStepIds: ['cleanup-1'],
          steps: ['step-1', 'step-2', 'cleanup-1'].map((stepId, index) => ({
            stepId,
            type: index === 1 ? 'verification' : 'setup',
            exec_order: index + 1,
            url: base.target.url,
            description: stepId,
            policy: [],
            expected: index === 0 ? [] : ['达到预期'],
          })),
          acceptanceCriteria: [
            {
              ...base.acceptanceCriteria[0],
              id: 'business-check',
              stepId: 'step-2',
            },
            {
              ...base.acceptanceCriteria[0],
              id: 'cleanup-check',
              stepId: 'cleanup-1',
            },
          ],
        };
        const report = {
          protocolVersion: '0.1',
          taskId: id,
          lifecycle: 'TIMED_OUT',
          executionDisposition: 'ERROR',
          verdict: null,
          summary: '清理超时夹具',
          artifacts: [
            {
              id: 'cleanup-report-evidence',
              kind: 'DOM',
              uri: 'https://example.test/v1/artifacts/cleanup-report-evidence',
              sha256: 'a'.repeat(64),
            },
          ],
          steps: ['step-1', 'step-2', 'cleanup-1'].map((stepId) => ({
            stepId,
            status: stepId === 'cleanup-1' ? 'ERROR' : 'COMPLETED',
            summary: '夹具',
            criteria: [],
            evidenceRefs: [],
            startedAt: null,
            finishedAt: null,
          })),
          criteria: [
            {
              criterionId: 'business-check',
              verdict: 'PASSED',
              summary: '业务通过夹具',
              evidenceRefs: ['cleanup-report-evidence'],
            },
            {
              criterionId: 'cleanup-check',
              verdict: 'FAILED',
              summary: '清理失败夹具',
              evidenceRefs: ['cleanup-report-evidence'],
            },
          ],
        };
        await sql.query(
          'UPDATE pr_tasks SET definition=$2,report=$3,state=$4 WHERE id=$1',
          [id, definition, report, 'TIMED_OUT'],
        );
        for (const blocked of [false, true]) {
          if (blocked) {
            report.steps[0]!.status = 'BLOCKED';
            await sql.query('UPDATE pr_tasks SET report=$2 WHERE id=$1', [
              id,
              report,
            ]);
          }
          const detail = (await api('GET', `/v1/tasks/${id}`)).data;
          const list = (await api('GET', `/v1/tasks?q=${id}&reportOnly=true`))
            .data;
          assert.equal(
            validateTaskList(list),
            true,
            JSON.stringify(validateTaskList.errors),
          );
          assert.equal(
            detail.reportStatus,
            blocked ? 'INCONCLUSIVE' : 'PASSED',
          );
          assert.deepEqual(detail.criteriaCounts, {
            total: 1,
            passed: 1,
            failed: 0,
            inconclusive: 0,
            skipped: 0,
          });
          assert.equal(list.tasks[0].reportStatus, detail.reportStatus);
          assert.deepEqual(list.tasks[0].criteriaCounts, detail.criteriaCounts);
          assert.equal(list.tasks[0].report_scope, undefined);
          assert.deepEqual(detail.report, report);
        }
      },
    );

    // 范围：角色凭据、一次性注册和任务定义幂等；不测试用户 SSO 或多租户权限。
    await suite.test('注册权限与不可变任务定义', async () => {
      assert.equal(
        (await api('GET', '/v1/nodes', undefined, WORKER)).status,
        401,
      );
      const enrollment = (
        await api('POST', '/v1/node-pairings', {
          type: 'node.enroll',
          pool: 'pair-test',
          name: '配对测试',
        })
      ).data;
      const body = {
        type: 'node.pair',
        nodeId: randomUUID(),
        pool: 'wrong',
        pairingToken: enrollment.pairingToken,
      };
      assert.equal((await api('POST', '/v1/nodes/pair', body)).status, 401);
      body.pool = 'pair-test';
      assert.equal((await api('POST', '/v1/nodes/pair', body)).status, 200);
      const recovered = await api('POST', '/v1/nodes/pair', body);
      assert.equal(recovered.status, 200);
      assert.equal(
        (await api('POST', '/v1/nodes/pair', { ...body, nodeId: randomUUID() }))
          .status,
        401,
      );
      const definition = task('unused');
      await submit(definition);
      await submit(definition);
      assert.equal(
        (
          await api('POST', '/v1/tasks', {
            ...definition,
            objective: '改变定义',
          })
        ).status,
        409,
      );
      // TRACE 已支持；无相应节点时排队，不伪造证据或降级类型。
      const traced = task('unused');
      traced.acceptanceCriteria[0]!.evidenceKinds = ['TRACE'];
      assert.equal((await api('POST', '/v1/tasks', traced)).status, 202);
      await api('POST', `/v1/tasks/${traced.taskId}/cancel`);
      await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
    });

    // 范围：数据库实例锁防止双控制面，释放后可恢复；不覆盖数据库主从切换。
    await suite.test('同一数据库只允许一个活动控制面', async () => {
      await assert.rejects(
        buildApp(config, { logger: false }),
        /Another ProofRun API/,
      );
      assert.equal((await api('GET', '/health/ready')).status, 200);
    });

    // 范围：离线池积压不阻挡在线池，排队也计入预算；不模拟大规模生产负载。
    await suite.test('跨资源池调度与队列截止时间', async () => {
      const blocked = Array.from({ length: 65 }, () => task('offline'));
      for (const definition of blocked) await submit(definition);
      await addNode('routable');
      const available = task('routable');
      await submit(available);
      const execution = await claim();
      assert.equal(execution.task.taskId, available.taskId);
      await api('POST', `/v1/tasks/${available.taskId}/cancel`);
      await cleaned(available.taskId);
      for (const definition of blocked)
        await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
      const expired = task('offline');
      expired.budget.timeoutMs = 100;
      await submit(expired);
      await until(
        async () =>
          (await api('GET', `/v1/tasks/${expired.taskId}`)).data.state,
        (state) => state === 'TIMED_OUT',
      );
      assert.equal(await claim(), null);
    });

    // 范围：真实 HTTP/数据库遵循节点准入而非占用数量，空闲节点也可拒绝；夹具不采样真实 CPU/内存。
    await suite.test('节点自主准入且 API 不按会话数量限制并发', async () => {
      const node = await addNode('node-admission-only');
      const readNode = async () =>
        (await api('GET', '/v1/nodes')).data.nodes.find(
          (row: { id: string }) => row.id === node.id,
        );
      const definitions = [task(node.pool), task(node.pool)];
      for (const definition of definitions) await submit(definition);

      node.acceptingOverride = false;
      node.heartbeat();
      await until(readNode, (row) => row.admission.accepting === false);
      assert.equal((await readNode()).occupied, 0);
      assert.equal(await claim(), null);
      assert.equal(
        (await api('GET', `/v1/tasks/${definitions[0]!.taskId}`)).data
          .queueReason.code,
        'NODE_CAPACITY',
      );

      node.acceptingOverride = true;
      node.heartbeat();
      await until(readNode, (row) => row.admission.accepting === true);
      for (const definition of definitions) {
        const execution = await claim();
        assert.equal(execution.task.taskId, definition.taskId);
        assert.equal(execution.nodeId, node.id);
        await ready(execution);
      }
      const listed = await readNode();
      assert.equal(listed.occupied, 2);
      assert.equal(Object.hasOwn(listed, 'capacity'), false);
      for (const definition of definitions) {
        await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
        await cleaned(definition.taskId);
      }
    });

    // 范围：真实事务中的并发领取遵循节点准入声明；准入和关闭来自协议夹具，不验证真实资源容量。
    await suite.test('并发领取遵循节点准入，清理后队列继续', async () => {
      await addNode('admission');
      await addNode('admission');
      const definitions = [
        task('admission'),
        task('admission'),
        task('admission'),
      ];
      for (const definition of definitions) await submit(definition);
      const claims = (
        await Promise.all(Array.from({ length: 8 }, claim))
      ).filter(Boolean);
      assert.equal(claims.length, 2);
      for (const execution of claims) await ready(execution);
      await api('POST', `/v1/tasks/${claims[0].task.taskId}/cancel`);
      await cleaned(claims[0].task.taskId);
      const third = await until<{ id: string; leaseToken: string }>(
        claim,
        Boolean,
      );
      assert.ok(third);
      for (const definition of definitions)
        await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
      for (const definition of definitions) await cleaned(definition.taskId);
    });

    // 范围：命令幂等、证据归属、文件摘要及报告聚合；不证明页面业务符合标准。
    // 范围：节点明确未启动时安全重排、旧令牌撤销与迟到结果去重；资源指标由夹具模拟。
    await suite.test('节点资源拒绝重排且旧执行不能复活', async () => {
      const node = await addNode('resource-reject');
      node.rejectOpen = true;
      const definition = task(node.pool);
      await submit(definition);
      const first = await claim();
      assert.ok(first);
      await until(
        async () => (await api('GET', `/v1/tasks/${definition.taskId}`)).data,
        (value) => value.state === 'QUEUED',
      );
      assert.equal(node.sessions.size, 0);
      assert.equal(
        (
          await api(
            'GET',
            `/v1/executions/${first.id}`,
            undefined,
            first.leaseToken,
          )
        ).status,
        404,
      );
      const archived = (
        await sql.query(
          'SELECT commands FROM pr_admission_rejections WHERE execution_id=$1',
          [first.id],
        )
      ).rows[0];
      assert.ok(archived);
      const result = node.results.get(
        archived.commands.find((c: any) => c.kind === 'session.open').id,
      );
      node.send(result);
      await sql.query(
        'UPDATE pr_nodes SET admission_retry_at=clock_timestamp() WHERE id=$1',
        [node.id],
      );
      const second = await until<any>(claim, Boolean);
      assert.notEqual(second.id, first.id);
      assert.notEqual(second.sessionId, first.sessionId);
      await ready(second);
      await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
      await cleaned(definition.taskId);
    });

    await suite.test('命令结果、证据与报告闭环', async () => {
      const node = await addNode('report');
      const definition = task('report', true);
      await submit(definition);
      const execution = await claim();
      await ready(execution);
      assert.equal(
        (await api('GET', `/v1/executions/${execution.id}`, undefined, WORKER))
          .status,
        401,
      );
      assert.equal(
        (
          await api(
            'POST',
            `/v1/executions/${execution.id}/commands`,
            {
              type: 'execution.command',
              commandId: randomUUID(),
              timeoutMs: 1000,
              command: { type: 'session.close' },
            },
            execution.leaseToken,
          )
        ).status,
        403,
      );
      const { request, result } = await command(execution, {
        type: 'browser.observe',
        screenshot: true,
      });
      const duplicate = await api(
        'POST',
        `/v1/executions/${execution.id}/commands`,
        request,
        execution.leaseToken,
      );
      assert.deepEqual(duplicate.data.result, result);
      assert.equal(node.calls.get(request.commandId), 1);
      assert.equal(
        (
          await api(
            'POST',
            `/v1/executions/${execution.id}/commands`,
            { ...request, timeoutMs: 1000 },
            execution.leaseToken,
          )
        ).status,
        409,
      );
      const screenshot = result.data.artifactRefs.find(
        (r: { kind: string }) => r.kind === 'SCREENSHOT',
      );
      const upload = (bytes: Buffer) =>
        fetch(`${base}/v1/artifacts/${screenshot.artifactId}`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${node.token}`,
            'content-type': 'image/png',
            'x-content-sha256': PNG_HASH,
          },
          body: new Uint8Array(bytes),
        });
      assert.equal((await upload(Buffer.from('wrong'))).status, 422);
      assert.equal((await upload(PNG)).status, 200);
      node.send({
        type: 'artifact.available',
        messageId: `artifact:${screenshot.artifactId}`,
        artifactId: screenshot.artifactId,
        sha256: PNG_HASH,
      });
      await until(
        async () =>
          (
            await api(
              'GET',
              `/v1/executions/${execution.id}`,
              undefined,
              execution.leaseToken,
            )
          ).data.artifacts,
        (rows) => rows.every((r: { state: string }) => r.state === 'AVAILABLE'),
      );
      const evidence = result.data.artifactRefs;
      const report = {
        protocolVersion: '0.1',
        taskId: definition.taskId,
        lifecycle: 'COMPLETED',
        executionDisposition: 'EXECUTED',
        verdict: 'PASSED',
        summary: '夹具协议校验完成',
        criteria: [
          {
            criterionId: 'visible',
            verdict: 'PASSED',
            summary: '证据归属已验证',
            evidenceRefs: evidence.map(
              (r: { artifactId: string }) => r.artifactId,
            ),
          },
        ],
        artifacts: evidence.map(
          (r: { artifactId: string; kind: string; sha256: string }) => ({
            id: r.artifactId,
            kind: r.kind,
            sha256: r.sha256,
            uri: 'https://invalid.example/not-authoritative',
          }),
        ),
      };
      const wrong = structuredClone(report);
      wrong.criteria[0]!.evidenceRefs = ['foreign-artifact'];
      assert.equal(
        (
          await api(
            'POST',
            `/v1/executions/${execution.id}/complete`,
            { type: 'execution.complete', report: wrong },
            execution.leaseToken,
          )
        ).status,
        422,
      );
      assert.equal(
        (
          await api(
            'POST',
            `/v1/executions/${execution.id}/complete`,
            { type: 'execution.complete', report },
            execution.leaseToken,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await api(
            'POST',
            `/v1/executions/${execution.id}/complete`,
            { type: 'execution.complete', report },
            execution.leaseToken,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await api(
            'POST',
            `/v1/executions/${execution.id}/complete`,
            {
              type: 'execution.complete',
              report: { ...report, summary: '改写已完成结论' },
            },
            execution.leaseToken,
          )
        ).status,
        409,
      );
      assert.deepEqual(
        (
          await api(
            'POST',
            `/v1/executions/${execution.id}/commands`,
            request,
            execution.leaseToken,
          )
        ).data.result,
        result,
      );
      const completed = await cleaned(definition.taskId);
      assert.equal(completed.state, 'COMPLETED');
      assert.ok(
        completed.report.artifacts.every((r: { uri: string }) =>
          r.uri.startsWith(base),
        ),
      );
      assert.equal(
        (
          await api(
            'GET',
            `/v1/artifacts/${screenshot.artifactId}`,
            undefined,
            WORKER,
          )
        ).status,
        401,
      );
      const download = await fetch(
        `${base}/v1/artifacts/${screenshot.artifactId}`,
        { headers: { authorization: `Bearer ${ADMIN}` } },
      );
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), PNG);
      const scoped = await fetch(
        `${base}/v1/executions/${execution.id}/artifacts/${screenshot.artifactId}`,
        { headers: { authorization: `Bearer ${execution.leaseToken}` } },
      );
      assert.equal(scoped.status, 200);
      assert.deepEqual(Buffer.from(await scoped.arrayBuffer()), PNG);
      archivedScreenshot = screenshot.artifactId;
    });

    // 范围：API 重启恢复域名及通配规则、持久结果和重复消息 ACK；不模拟 PostgreSQL 磁盘损坏。
    await suite.test('API 重启与重复结果不重执行', async () => {
      const node = await addNode('restart');
      await api('POST', `/v1/nodes/${node.id}/routing`, {
        domains: ['127.0.0.1', '*.restart.example'],
        revision: 0,
      });
      const definition = task('restart');
      await submit(definition);
      const execution = await claim();
      await ready(execution);
      assert.equal(
        (
          await api(
            'GET',
            `/v1/executions/${execution.id}/artifacts/${archivedScreenshot}`,
            undefined,
            execution.leaseToken,
          )
        ).status,
        404,
      );
      const { request, result } = await command(execution, {
        type: 'browser.observe',
      });
      await app.close();
      app = await buildApp(config, { logger: false });
      await app.listen({ host: config.host, port });
      await node.connect();
      await until(
        async () => (await api('GET', '/v1/nodes')).data.nodes,
        (rows) =>
          rows.some(
            (r: { id: string; online: boolean }) =>
              r.id === node.id && r.online,
          ),
      );
      const persisted = (await api('GET', '/v1/nodes')).data.nodes.find(
        (n: { id: string }) => n.id === node.id,
      );
      // 这里只验证规则完整保留；数据库排序受 locale 影响，不属于持久化契约。
      assert.deepEqual(persisted.routing_domains.toSorted(), [
        '*.restart.example',
        '127.0.0.1',
      ]);
      assert.equal(persisted.routing_revision, 1);
      node.send(node.results.get(request.commandId));
      const repeated = await api(
        'POST',
        `/v1/executions/${execution.id}/commands`,
        request,
        execution.leaseToken,
      );
      assert.deepEqual(repeated.data.result, result);
      assert.equal(node.calls.get(request.commandId), 1);
      assert.equal(
        Number(
          (
            await sql.query(
              'SELECT count(*) FROM pr_node_inbox WHERE node_id=$1 AND message_id=$2',
              [node.id, request.commandId],
            )
          ).rows[0].count,
        ),
        1,
      );
      await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
      await cleaned(definition.taskId);
    });

    // 范围：worker 失联后撤权及关闭未核实占位；夹具故意忽略关闭，不代表真实系统清理失败。
    await suite.test('执行租约过期仍保留未核实容量', async () => {
      const node = await addNode('expiry');
      node.ignoreClose = true;
      const first = task('expiry');
      const second = task('expiry');
      await submit(first);
      await submit(second);
      const execution = await claim();
      await ready(execution);
      await until(
        async () => (await api('GET', `/v1/tasks/${first.taskId}`)).data.state,
        (state) => state === 'ERROR',
        7000,
      );
      // 范围：节点上报与数据库占用取并集，同一会话不能重复计数，未确认关闭仍保留占用。
      const occupiedNode = (await api('GET', '/v1/nodes')).data.nodes.find(
        (item: { id: string }) => item.id === node.id,
      );
      assert.equal(occupiedNode.occupied, 1);
      assert.equal(await claim(), null);
      assert.equal(
        (
          await api(
            'POST',
            `/v1/executions/${execution.id}/heartbeat`,
            undefined,
            execution.leaseToken,
          )
        ).status,
        409,
      );
      node.closed(execution.sessionId);
      node.heartbeat();
      await cleaned(first.taskId);
      const next = await until<{ id: string; leaseToken: string }>(
        claim,
        Boolean,
      );
      assert.ok(next);
      node.ignoreClose = false;
      await api('POST', `/v1/tasks/${second.taskId}/cancel`);
      await cleaned(second.taskId);
    });

    // 范围：真实数据库与网关保留迟到续期回执且允许后续动作；会话真实过期仍撤权，不模拟 Chrome。
    await suite.test('迟到续期不能误杀有效会话，真正过期仍终止', async () => {
      for (const code of [
        'LEASE_EXPIRED',
        'DEADLINE_EXCEEDED',
        'SESSION_EXPIRED',
      ]) {
        const node = await addNode(`renew-${code}`);
        node.renewalErrors.push(code);
        const definition = task(`renew-${code}`);
        await submit(definition);
        const execution = await claim();
        await ready(execution);
        await until(
          async () =>
            (
              await sql.query(
                "SELECT 1 FROM pr_commands WHERE execution_id=$1 AND kind='session.renew' AND result#>>'{error,code}'=$2",
                [execution.id, code],
              )
            ).rowCount,
          Boolean,
        );
        if (code === 'SESSION_EXPIRED') {
          await cleaned(definition.taskId);
          assert.equal(
            (await api('GET', `/v1/tasks/${definition.taskId}`)).data.state,
            'ERROR',
          );
        } else {
          assert.equal(
            (await command(execution, { type: 'browser.observe' })).result
              .operationStatus,
            'SUCCEEDED',
          );
          assert.equal(
            (await api('GET', `/v1/tasks/${definition.taskId}`)).data.state,
            'RUNNING',
          );
          await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
          await cleaned(definition.taskId);
        }
      }
    });

    // 范围：投递过的续期回执缺失不会触发通用命令超时撤权；真正 worker 超时由已有回归覆盖。
    await suite.test('单条续期回执超时后可由新心跳继续续期', async () => {
      const node = await addNode('renew-receipt-timeout');
      node.holdRenewals = true;
      const definition = task('renew-receipt-timeout');
      await submit(definition);
      const execution = await claim();
      await ready(execution);
      const pending = await until<{ id: string }>(
        async () =>
          (
            await sql.query(
              "SELECT id FROM pr_commands WHERE execution_id=$1 AND kind='session.renew' AND first_sent_at IS NOT NULL AND result IS NULL LIMIT 1",
              [execution.id],
            )
          ).rows[0],
        Boolean,
      );
      await sql.query(
        "UPDATE pr_commands SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [pending.id],
      );
      await until(
        async () =>
          (
            await sql.query('SELECT result FROM pr_commands WHERE id=$1', [
              pending.id,
            ])
          ).rows[0].result,
        Boolean,
      );
      node.holdRenewals = false;
      node.heartbeat();
      await until(
        async () =>
          (
            await sql.query(
              "SELECT 1 FROM pr_commands WHERE execution_id=$1 AND kind='session.renew' AND result->>'operationStatus'='SUCCEEDED'",
              [execution.id],
            )
          ).rowCount,
        Boolean,
      );
      assert.equal(
        (await command(execution, { type: 'browser.observe' })).result
          .operationStatus,
        'SUCCEEDED',
      );
      await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
      await cleaned(definition.taskId);
    });

    // 范围：真实行锁被持有时多路状态快照仍返回，另一个执行仍可续租；不声称覆盖生产吞吐量。
    await suite.test(
      '状态轮询不等待执行写锁，也不挤占其他执行续租',
      async () => {
        // 同节点心跳会在一个事务中依次锁住全部会话，其遍历顺序不固定。
        // 两个执行分属不同节点，排除心跳跨会话锁的干扰，只验证状态读取是否占住连接池。
        await addNode('read-snapshot');
        await addNode('read-snapshot-other');
        const definitions = [
          task('read-snapshot'),
          task('read-snapshot-other'),
        ];
        for (const definition of definitions) await submit(definition);
        const first = await claim();
        await ready(first);
        const second = await claim();
        await ready(first);
        await ready(second);
        const blocker = await sql.connect();
        try {
          await blocker.query('BEGIN');
          await blocker.query(
            'SELECT id FROM pr_executions WHERE id=$1 FOR UPDATE',
            [first.id],
          );
          // 续租与读取同时进行；所有请求结束后才释放行锁，失败也不能留下后台请求污染后续用例。
          const results = await Promise.allSettled([
            ...Array.from({ length: SNAPSHOT_READERS }, async (_, index) => {
              try {
                const response = await fetch(
                  `${base}/v1/executions/${first.id}`,
                  {
                    headers: { authorization: `Bearer ${first.leaseToken}` },
                    signal: AbortSignal.timeout(SNAPSHOT_REQUEST_MS),
                  },
                );
                assert.equal(response.status, 200);
                assert.equal((await response.json()).state, 'RUNNING');
              } catch (cause) {
                throw new Error(
                  `状态读取 ${index + 1} 在执行写锁持有期间失败`,
                  { cause },
                );
              }
            }),
            (async () => {
              try {
                const response = await fetch(
                  `${base}/v1/executions/${second.id}/heartbeat`,
                  {
                    method: 'POST',
                    headers: { authorization: `Bearer ${second.leaseToken}` },
                    signal: AbortSignal.timeout(SNAPSHOT_REQUEST_MS),
                  },
                );
                assert.equal(response.status, 200);
                await response.json();
              } catch (cause) {
                throw new Error('独立节点执行的续租被状态轮询阻塞', { cause });
              }
            })(),
          ]);
          const failures = results.filter(
            (result) => result.status === 'rejected',
          );
          if (failures.length)
            throw new AggregateError(
              failures.map((failure) => failure.reason),
              '持锁期间的读取或续租失败',
            );
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
          for (const definition of definitions) {
            await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
            await cleaned(definition.taskId);
          }
        }
      },
    );

    // 范围：真实心跳事务等待 execution 时不阻塞命令所需的节点外键锁。
    // 用数据库锁构造稳定交错，不模拟生产吞吐量或所有可能的锁冲突。
    await suite.test('心跳与命令外键检查不形成锁循环', async () => {
      const node = await addNode('lock-order');
      const definition = task('lock-order');
      await submit(definition);
      const execution = await claim();
      await ready(execution);
      const blocker = await sql.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query("SET LOCAL lock_timeout='500ms'");
        await blocker.query(
          'SELECT id FROM pr_executions WHERE id=$1 FOR UPDATE',
          [execution.id],
        );
        node.heartbeat();
        await until(
          async () =>
            (
              await sql.query(`SELECT 1 FROM pg_stat_activity a
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
            AND query LIKE '%WHERE e.id=$1 FOR UPDATE OF e,t,s%'
            AND EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.relation='pr_nodes'::regclass
              AND l.mode='RowExclusiveLock' AND l.granted)`)
            ).rowCount,
          Boolean,
        );
        await blocker.query(
          'SELECT id FROM pr_nodes WHERE id=$1 FOR KEY SHARE',
          [node.id],
        );
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
      await cleaned(definition.taskId);
    });

    // 范围：节点只读 DOM 故障保留原始回执且不撤权，可采集新观察；不验证真实 CDP 可恢复性。
    await suite.test(
      '只读 DOM 故障不终止执行，也不自动重放原命令',
      async () => {
        const node = await addNode('dom-read-recovery');
        node.domObservationFailures = 1;
        const definition = task('dom-read-recovery');
        await submit(definition);
        const execution = await claim();
        await ready(execution);
        const failed = await command(execution, { type: 'browser.observe' });
        assert.equal(failed.result.error.code, 'DOM_ENGINE_FAILED');
        assert.equal(failed.result.effect, 'MAY_HAVE_HAPPENED');
        assert.equal(
          (await api('GET', `/v1/tasks/${definition.taskId}`)).data.state,
          'RUNNING',
        );
        const recovered = await command(execution, { type: 'browser.observe' });
        assert.equal(recovered.result.operationStatus, 'SUCCEEDED');
        assert.equal(node.calls.get(failed.request.commandId), 1);
        assert.equal(node.calls.get(recovered.request.commandId), 1);
        await api('POST', `/v1/tasks/${definition.taskId}/cancel`, {});
        await cleaned(definition.taskId);
        assert.equal(
          (
            await api(
              'POST',
              `/v1/executions/${execution.id}/commands`,
              {
                ...recovered.request,
                commandId: randomUUID(),
              },
              execution.leaseToken,
            )
          ).status,
          409,
        );
      },
    );

    // 范围：真实 API/数据库区分已确认未发送按键与传输未知；真实聚焦由独立 Chromium 测试覆盖。
    await suite.test('聚焦回执允许补采而传输未知仍终止', async () => {
      for (const failure of ['confirmed', 'transport'] as const) {
        const node = await addNode(`focus-${failure}`);
        node.focusFailure = failure;
        const definition = task(node.pool);
        await submit(definition);
        const execution = await claim();
        await ready(execution);
        const failed = await command(execution, {
          type: 'browser.act',
          action: 'press',
          value: 'Enter',
          target: 'fixture-target',
          observationId: 'fixture-observation',
        });
        assert.equal(failed.result.operationStatus, 'UNKNOWN');
        if (failure === 'confirmed') {
          assert.equal(
            (await api('GET', `/v1/tasks/${definition.taskId}`)).data.state,
            'RUNNING',
          );
          const recovered = await command(execution, {
            type: 'browser.observe',
          });
          assert.equal(recovered.result.operationStatus, 'SUCCEEDED');
          await api('POST', `/v1/tasks/${definition.taskId}/cancel`, {});
        }
        await cleaned(definition.taskId);
        assert.equal(node.calls.get(failed.request.commandId), 1);
      }
    });

    // 范围：不确定写入结束执行且不能使用新命令绕过；不证明真实引擎内部没有重试。
    await suite.test('未知写入不自动重放，旧执行不能继续操作', async () => {
      const node = await addNode('unknown');
      node.unknownWrite = true;
      const definition = task('unknown');
      await submit(definition);
      const execution = await claim();
      await ready(execution);
      const result = await command(execution, {
        type: 'browser.act',
        action: 'navigate',
        target: 'http://127.0.0.1/',
      });
      assert.equal(result.result.effect, 'MAY_HAVE_HAPPENED');
      await cleaned(definition.taskId);
      assert.equal(node.calls.get(result.request.commandId), 1);
      assert.equal(
        (
          await api(
            'POST',
            `/v1/executions/${execution.id}/commands`,
            { ...result.request, commandId: randomUUID() },
            execution.leaseToken,
          )
        ).status,
        409,
      );
    });

    // 范围：真实数据库和协议节点的控制交接、旧请求隔离及共享预算；不验证真实人工操作页面。
    await suite.test('人工交接保持单一操作权，旧代次不能操作', async () => {
      await addNode('human');
      const definition = {
        ...task('human'),
        environment: {
          id: 'fixture',
          nodePool: 'human',
          allowIntervention: true,
        },
      };
      await submit(definition);
      const execution = await claim();
      await ready(execution);
      const base = `/v1/admin/executions/${execution.id}`;
      assert.equal(
        (
          await api('POST', `${base}/intervene`, {
            type: 'execution.intervene',
            reason: '检查登录',
            controlRevision: 0,
          })
        ).status,
        200,
      );
      const request = {
        type: 'execution.command',
        commandId: randomUUID(),
        timeoutMs: 5000,
        controlRevision: 1,
        command: { type: 'browser.observe' },
      };
      assert.equal(
        (await api('POST', `${base}/commands`, request)).status,
        409,
      );
      assert.equal(
        (
          await api('POST', `${base}/control`, {
            type: 'execution.control',
            action: 'acknowledge',
            controlRevision: 1,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await api(
            'POST',
            `/v1/executions/${execution.id}/control`,
            {
              type: 'execution.control',
              action: 'acknowledge',
              controlRevision: 1,
            },
            execution.leaseToken,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await api(
            'POST',
            `/v1/executions/${execution.id}/commands`,
            request,
            execution.leaseToken,
          )
        ).status,
        409,
      );
      assert.equal(
        (await api('POST', `${base}/commands`, request)).status,
        202,
      );
      const activity = await until(
        async () => (await api('GET', `${base}/activity`)).data,
        (v) =>
          v.commands.some(
            (c: { id: string; status: string }) =>
              c.id === request.commandId && c.status === 'SUCCEEDED',
          ),
      );
      assert.ok(
        validateExecutionActivity(activity),
        JSON.stringify(validateExecutionActivity.errors),
      );
      assert.equal(
        activity.commands.find(
          (c: { id: string }) => c.id === request.commandId,
        )?.actor,
        'HUMAN',
      );
      assert.ok(!JSON.stringify(activity).includes(execution.leaseToken));
      assert.equal(
        (
          await api('POST', `${base}/control`, {
            type: 'execution.control',
            action: 'resume',
            controlRevision: 1,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await api('POST', `${base}/commands`, {
            ...request,
            commandId: randomUUID(),
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await api(
            'POST',
            `/v1/executions/${execution.id}/commands`,
            { ...request, commandId: randomUUID(), controlRevision: 0 },
            execution.leaseToken,
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await api(
            'POST',
            `/v1/executions/${execution.id}/commands`,
            { ...request, commandId: randomUUID(), controlRevision: 2 },
            execution.leaseToken,
          )
        ).status,
        202,
      );
      await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
      await cleaned(definition.taskId);
      assert.equal(
        (
          await api('POST', `${base}/control`, {
            type: 'execution.control',
            action: 'resume',
            controlRevision: 1,
          })
        ).status,
        409,
      );
    });

    // 范围：数据库时钟前移模拟长等待，验证暂停、链接轮换、恢复幂等和失联回收；不等待真实四小时或操作真实浏览器。
    await suite.test(
      '人工等待不消耗执行时限，链接四小时且恢复重置二十分钟',
      async (t) => {
        const node = await addNode('human-time');
        node.renewableSessions = false;
        node.heartbeat();
        await until(
          async () => (await api('GET', '/v1/nodes')).data.nodes,
          (rows) =>
            rows.some(
              (n: any) =>
                n.id === node.id && n.capabilities.renewableSessions === false,
            ),
        );
        const definition = {
          ...task('human-time'),
          environment: {
            id: 'fixture',
            nodePool: 'human-time',
            allowIntervention: true,
          },
          budget: { timeoutMs: 60000, maxActions: 20 },
        };
        await submit(definition);
        assert.equal(
          (
            await api(
              'POST',
              '/v1/worker/claim',
              { type: 'worker.claim', workerId: 'legacy-check' },
              WORKER,
            )
          ).data.execution,
          null,
        );
        node.renewableSessions = true;
        node.heartbeat();
        // 心跳发送不等于能力已落库；确认可续期能力后再领取，避免空领取遗留任务污染后续用例。
        await until(
          async () => (await api('GET', '/v1/nodes')).data.nodes,
          (rows) =>
            rows.some(
              (n: any) =>
                n.id === node.id && n.capabilities.renewableSessions === true,
            ),
        );
        const execution = await claim();
        const worker = new SimulatedWorker(base, execution);
        t.after(() => worker.close());
        await ready(execution);
        const adminPath = `/v1/admin/executions/${execution.id}`;
        const workerPath = `/v1/executions/${execution.id}`;
        await api('POST', `${adminPath}/intervene`, {
          type: 'execution.intervene',
          reason: '等待用户',
          controlRevision: 0,
        });
        const humanDeadline = (
          await api('GET', `/v1/tasks/${definition.taskId}`)
        ).data.executionOutcome.waitDeadline;
        const link = (await api('GET', `${adminPath}/intervention`)).data
          .intervention;
        assert.ok(Date.parse(link.expiresAt) - Date.now() > 4 * 3600000 - 5000);
        assert.ok(Date.parse(link.expiresAt) - Date.now() <= 4 * 3600000);
        await sql.query(
          "UPDATE pr_tasks SET deadline_at=clock_timestamp()-interval '1 hour' WHERE id=$1",
          [definition.taskId],
        );
        await delay(150);
        assert.equal(
          (await api('GET', `/v1/tasks/${definition.taskId}`)).data.state,
          'RUNNING',
        );
        const heartbeat = await api(
          'POST',
          `${workerPath}/heartbeat`,
          undefined,
          execution.leaseToken,
        );
        assert.equal(heartbeat.status, 200);
        assert.equal(heartbeat.data.controlMode, 'REQUESTED');
        assert.ok(Date.parse(heartbeat.data.leaseExpiresAt) > Date.now());
        assert.equal(
          (
            await api(
              'POST',
              `${workerPath}/control`,
              {
                type: 'execution.control',
                action: 'acknowledge',
                controlRevision: 1,
              },
              execution.leaseToken,
            )
          ).status,
          200,
        );
        await sql.query(
          "UPDATE pr_interventions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [link.id],
        );
        await delay(150);
        assert.equal(
          (await api('GET', `/v1/tasks/${definition.taskId}`)).data.state,
          'RUNNING',
        );
        const renewed = (await api('GET', `${adminPath}/intervention`)).data
          .intervention;
        // 安全点确认及链接轮换不能延长任务人工等待期限。
        assert.equal(
          (await api('GET', `/v1/tasks/${definition.taskId}`)).data
            .executionOutcome.waitDeadline,
          humanDeadline,
        );
        assert.notEqual(renewed.id, link.id);
        assert.notEqual(renewed.url, link.url);
        assert.ok(
          Date.parse(renewed.expiresAt) - Date.now() > 4 * 3600000 - 5000,
        );
        assert.equal(
          (await api('GET', `${adminPath}/intervention`)).data.intervention.id,
          renewed.id,
        );
        const { ws: stale, messages } = await connectHitl(
          base,
          link.id,
          link.path.split('/').at(-1),
        );
        t.after(() => stale.terminate());
        await until(
          async () => messages,
          (rows) => rows.some((m) => m.type === 'error'),
        );
        const commandId = randomUUID();
        assert.equal(
          (
            await api('POST', `${adminPath}/commands`, {
              type: 'execution.command',
              commandId,
              controlRevision: 1,
              timeoutMs: 1000,
              command: { type: 'browser.input', action: 'press', value: 'Tab' },
            })
          ).status,
          202,
        );
        await until(
          async () => (await api('GET', `${adminPath}/activity`)).data,
          (d) =>
            d.commands.some(
              (c: any) => c.id === commandId && c.status === 'SUCCEEDED',
            ),
        );
        const resume = {
          type: 'execution.control',
          action: 'resume',
          controlRevision: 1,
        };
        assert.equal(
          (await api('POST', `${adminPath}/control`, resume)).status,
          200,
        );
        const resumed = (
          await api('GET', workerPath, undefined, execution.leaseToken)
        ).data;
        const resumedOutcome = (
          await api('GET', `/v1/tasks/${definition.taskId}`)
        ).data.executionOutcome;
        assert.equal(resumedOutcome.waitDeadline, null);
        assert.equal(resumedOutcome.waitingSince, null);
        assert.equal(resumedOutcome.category, 'RUNNING');
        assert.equal(resumed.controlMode, 'AUTO');
        assert.equal(resumed.actionCount, 0);
        assert.ok(
          Date.parse(resumed.taskDeadlineAt) - Date.now() > 20 * 60000 - 5000,
        );
        assert.ok(
          Date.parse(resumed.taskDeadlineAt) - Date.now() <= 20 * 60000,
        );
        await api('POST', `${adminPath}/control`, resume);
        assert.equal(
          (await api('GET', workerPath, undefined, execution.leaseToken)).data
            .taskDeadlineAt,
          resumed.taskDeadlineAt,
        );
        // 恢复后重新服从时限；只有人工暂停可越过旧 deadline。
        await sql.query(
          'UPDATE pr_tasks SET deadline_at=clock_timestamp() WHERE id=$1',
          [definition.taskId],
        );
        await until(
          async () => (await api('GET', `/v1/tasks/${definition.taskId}`)).data,
          (d) => d.state === 'TIMED_OUT',
        );
        assert.equal(
          (await api('POST', `${adminPath}/control`, resume)).status,
          409,
        );
        await cleaned(definition.taskId);
      },
    );

    // 范围：真实数据库/HTTP 验证独立人工期限、恢复边界与关闭原因；节点关闭由协议夹具模拟。
    await suite.test(
      '人工等待超时与提前关闭分别归类并保留环境阻塞',
      async () => {
        for (const ending of ['timeout', 'NODE_SHUTDOWN', 'legacy'] as const) {
          const node = await addNode(`ending-${ending}`);
          node.holdClosedEvent = ending === 'timeout';
          const definition = {
            ...task(`ending-${ending}`),
            environment: {
              id: 'fixture',
              nodePool: `ending-${ending}`,
              allowIntervention: true,
            },
          };
          await submit(definition);
          const execution = await claim();
          await ready(execution);
          const path = `/v1/admin/executions/${execution.id}`;
          assert.equal(
            (
              await api('POST', `${path}/intervene`, {
                type: 'execution.intervene',
                reason: '缺少授权子账号',
                reasonCode: 'ENVIRONMENT_NOT_READY',
                controlRevision: 0,
              })
            ).status,
            200,
          );
          const waiting = (await api('GET', `/v1/tasks/${definition.taskId}`))
            .data;
          assert.equal(waiting.executionOutcome.category, 'WAITING_HUMAN');
          const deadline = waiting.executionOutcome.waitDeadline;
          assert.ok(Date.parse(deadline) > Date.now() + 29 * 60_000);
          // 重送同一交接请求不延长等待，链接刷新也不能替换这个持久时钟。
          await api('POST', `${path}/intervene`, {
            type: 'execution.intervene',
            reason: '缺少授权子账号',
            reasonCode: 'ENVIRONMENT_NOT_READY',
            controlRevision: 0,
          });
          assert.equal(
            (await api('GET', `/v1/tasks/${definition.taskId}`)).data
              .executionOutcome.waitDeadline,
            deadline,
          );
          if (ending === 'timeout') {
            await sql.query(
              "UPDATE pr_executions SET human_deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
              [execution.id],
            );
          } else
            node.closed(
              execution.sessionId,
              ending === 'legacy' ? undefined : ending,
            );
          const result = await until(
            async () =>
              (await api('GET', `/v1/tasks/${definition.taskId}`)).data,
            (d) => d.state !== 'RUNNING',
          );
          assert.equal(
            result.executionOutcome.category,
            ending === 'timeout' ? 'HUMAN_TIMEOUT' : 'ENVIRONMENT_BLOCKED',
          );
          assert.equal(
            result.executionOutcome.reasonCode,
            'ENVIRONMENT_NOT_READY',
          );
          assert.equal(
            result.executionOutcome.terminationCode,
            ending === 'timeout'
              ? 'HUMAN_INTERVENTION_TIMEOUT'
              : ending === 'legacy'
                ? 'SESSION_ENDED'
                : ending,
          );
          assert.equal(
            result.executions[0].close_reason,
            ending === 'NODE_SHUTDOWN' ? ending : null,
          );
          assert.equal(
            (
              await api('POST', `${path}/control`, {
                type: 'execution.control',
                action: 'resume',
                controlRevision: 1,
              })
            ).status,
            409,
          );
          const list = (
            await api('GET', `/v1/tasks?q=${definition.taskId}`)
          ).data.tasks.find((r: any) => r.id === definition.taskId);
          assert.deepEqual(list.executionOutcome, result.executionOutcome);
          assert.ok(
            validateTaskDetail(result),
            JSON.stringify(validateTaskDetail.errors),
          );
          await cleaned(definition.taskId);
          if (ending === 'timeout') {
            // 关闭命令先确认、事件后到，仍保留节点原因且不覆盖任务人工超时。
            node.closed(execution.sessionId, 'SESSION_CLOSE_REQUESTED');
            const closed = await until(
              async () =>
                (await api('GET', `/v1/tasks/${definition.taskId}`)).data,
              (d) => d.executions[0].close_reason === 'SESSION_CLOSE_REQUESTED',
            );
            assert.equal(
              closed.executionOutcome.terminationCode,
              'HUMAN_INTERVENTION_TIMEOUT',
            );
          }
        }
      },
    );

    // 范围：真实控制面中 Agent 额度耗尽后人工仍能操作、去重且不加时/加额度；节点为协议夹具，不验证真实登录。
    await suite.test(
      'HITL 不受 Agent 动作预算限制，迁移校准活动执行计数',
      async (t) => {
        const node = await addNode('human-actions');
        const definition = {
          ...task('human-actions'),
          environment: {
            id: 'fixture',
            nodePool: 'human-actions',
            allowIntervention: true,
          },
          budget: { timeoutMs: 60000, maxActions: 1 },
        };
        await submit(definition);
        const execution = await claim();
        const worker = new SimulatedWorker(base, execution);
        t.after(() => worker.close());
        await ready(execution);
        await command(execution, {
          type: 'browser.act',
          action: 'navigate',
          target: definition.target.url,
        });
        const adminPath = `/v1/admin/executions/${execution.id}`;
        const workerPath = `/v1/executions/${execution.id}`;
        await api('POST', `${adminPath}/intervene`, {
          type: 'execution.intervene',
          reason: '人工处理',
          controlRevision: 0,
        });
        await api(
          'POST',
          `${workerPath}/control`,
          {
            type: 'execution.control',
            action: 'acknowledge',
            controlRevision: 1,
          },
          execution.leaseToken,
        );
        const operations = [
          { type: 'browser.input', action: 'scroll', x: 1, y: 1, deltaY: 20 },
          {
            type: 'browser.cookies.set',
            url: definition.target.url,
            name: 'token',
            value: 'fixture',
            httpOnly: true,
          },
          { type: 'browser.act', action: 'reload' },
        ];
        for (const operation of operations) {
          const commandId = randomUUID();
          const request = {
            type: 'execution.command',
            commandId,
            controlRevision: 1,
            timeoutMs: 1000,
            command: operation,
          };
          assert.equal(
            (await api('POST', `${adminPath}/commands`, request)).status,
            202,
          );
          await until(
            async () => (await api('GET', `${adminPath}/activity`)).data,
            (d) =>
              d.commands.some(
                (c: any) => c.id === commandId && c.status === 'SUCCEEDED',
              ),
          );
          assert.equal(
            (await api('POST', `${adminPath}/commands`, request)).status,
            202,
          );
          assert.equal(node.calls.get(commandId), 1);
        }
        const view = async () =>
          (await api('GET', workerPath, undefined, execution.leaseToken)).data;
        assert.equal((await view()).actionCount, 1);
        // 模拟旧版将三个人工命令也计数；迁移只恢复实际自动额度，重复执行结果不变。
        await sql.query('UPDATE pr_executions SET action_count=4 WHERE id=$1', [
          execution.id,
        ]);
        const migration = await readFile(
          new URL('../migrations/011-agent-action-budget.sql', import.meta.url),
          'utf8',
        );
        const historical = (
          await sql.query(
            "SELECT id,action_count FROM pr_executions WHERE state='FINISHED' ORDER BY id",
          )
        ).rows;
        await sql.query(migration);
        await sql.query(migration);
        assert.equal((await view()).actionCount, 1);
        assert.deepEqual(
          (
            await sql.query(
              "SELECT id,action_count FROM pr_executions WHERE state='FINISHED' ORDER BY id",
            )
          ).rows,
          historical,
        );
        await api('POST', `${adminPath}/control`, {
          type: 'execution.control',
          action: 'resume',
          controlRevision: 1,
        });
        const denied = await api(
          'POST',
          `${workerPath}/commands`,
          {
            type: 'execution.command',
            commandId: randomUUID(),
            controlRevision: 2,
            timeoutMs: 1000,
            command: { type: 'browser.act', action: 'reload' },
          },
          execution.leaseToken,
        );
        assert.equal(denied.status, 409);
        assert.equal(denied.data.code, 'ACTION_BUDGET_EXCEEDED');
        await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
        await cleaned(definition.taskId);
      },
    );

    // 范围：人工暂停不能续活失联 worker；数据库回拨租约，不模拟真实网络故障。
    await suite.test('人工等待仍回收已失联的执行租约', async () => {
      await addNode('human-lost');
      const definition = {
        ...task('human-lost'),
        environment: {
          id: 'fixture',
          nodePool: 'human-lost',
          allowIntervention: true,
        },
      };
      await submit(definition);
      const execution = await claim();
      await ready(execution);
      await api('POST', `/v1/admin/executions/${execution.id}/intervene`, {
        type: 'execution.intervene',
        reason: '等待人工',
        controlRevision: 0,
      });
      await sql.query(
        'UPDATE pr_executions SET lease_expires_at=clock_timestamp() WHERE id=$1',
        [execution.id],
      );
      const ended = await until(
        async () => (await api('GET', `/v1/tasks/${definition.taskId}`)).data,
        (d) => d.state === 'ERROR',
      );
      assert.equal(ended.error.code, 'WORKER_LEASE_EXPIRED');
      assert.equal(
        (await api('GET', `/v1/admin/executions/${execution.id}/intervention`))
          .data.intervention,
        null,
      );
      await cleaned(definition.taskId);
    });

    // 范围：跨初始租约的人工接管与重连、独立链接、单一操作者、输入去重和完成撤权；节点画面为夹具，不证明 Chrome 交互。
    await suite.test('独立 HITL 链接限定本次任务并在完成后撤权', async (t) => {
      const node = await addNode('hitl-link');
      const definition = {
        ...task('hitl-link'),
        environment: {
          id: 'fixture',
          nodePool: 'hitl-link',
          allowIntervention: true,
        },
        budget: { timeoutMs: 60000, maxActions: 20 },
      };
      await submit(definition);
      const execution = await claim();
      const worker = new SimulatedWorker(base, execution);
      t.after(() => worker.close());
      await ready(execution);
      const adminPath = `/v1/admin/executions/${execution.id}`;
      await api('POST', `${adminPath}/intervene`, {
        type: 'execution.intervene',
        reason: '需要人工登录',
        items: ['完成登录', '确认工作区'],
        controlRevision: 0,
      });
      const link = (await api('GET', `${adminPath}/intervention`)).data
        .intervention;
      assert.deepEqual(link.items, ['完成登录', '确认工作区']);
      const token = link.path.split('/').at(-1);
      assert.equal(
        (await api('GET', '/v1/tasks', undefined, token)).status,
        401,
      );
      assert.equal(
        (await api('GET', `${adminPath}/activity`, undefined, token)).status,
        401,
      );
      const sockets: Awaited<ReturnType<typeof connectHitl>>['ws'][] = [];
      const connect = async (credential = token) => {
        const connection = await connectHitl(base, link.id, credential);
        sockets.push(connection.ws);
        return connection;
      };
      try {
        const invalid = await connect('x'.repeat(43));
        await until(
          async () => invalid.messages,
          (rows) => rows.some((m) => m.code === 'HITL_INVALID'),
        );
        let first = await connect();
        await until(
          async () => first.messages,
          (rows) =>
            rows.some((m) => m.type === 'state' && m.mode === 'REQUESTED'),
        );
        assert.ok(
          !JSON.stringify(first.messages).includes(execution.leaseToken),
        );
        await api(
          'POST',
          `/v1/executions/${execution.id}/control`,
          {
            type: 'execution.control',
            action: 'acknowledge',
            controlRevision: 1,
          },
          execution.leaseToken,
        );
        await until(
          async () => first.messages,
          (rows) => rows.some((m) => m.type === 'frame'),
        );
        const duplicate = await connect();
        await until(
          async () => duplicate.messages,
          (rows) => rows.some((m) => m.code === 'HITL_OCCUPIED'),
        );
        // 人工已接管后跨过首次授权期限，再断开和重连，验证 worker 在等待用户时仍续租。
        await delay(
          Math.max(0, Date.parse(execution.leaseExpiresAt) - Date.now()) +
            LEASE_BOUNDARY_MARGIN_MS,
        );
        first.ws.send(
          JSON.stringify({
            type: 'command',
            commandId: randomUUID(),
            command: { type: 'session.close' },
          }),
        );
        await until(
          async () => first.messages,
          (rows) => rows.some((m) => m.code === 'HITL_COMMAND'),
        );
        await until(
          async () => first.ws.readyState,
          (ready) => ready === WebSocket.CLOSED,
        );
        first = await connect();
        await until(
          async () => first.messages,
          (rows) => rows.some((m) => m.type === 'frame'),
        );
        const commandId = randomUUID();
        const input = {
          type: 'command',
          commandId,
          command: {
            type: 'browser.input',
            action: 'text',
            value: 'fixture-only',
          },
        };
        first.ws.send(JSON.stringify(input));
        await until(
          async () => first.messages,
          (rows) =>
            rows.some(
              (m) =>
                m.type === 'result' &&
                m.commandId === commandId &&
                m.status === 'SUCCEEDED',
            ),
        );
        first.ws.send(JSON.stringify(input));
        await until(
          async () => first.messages,
          (rows) =>
            rows.filter((m) => m.type === 'result' && m.commandId === commandId)
              .length === 2,
        );
        assert.equal(node.calls.get(commandId), 1);
        // 直连输入也进入统一时间线，但不能泄露输入值；这里仅验证协议事件的数据库投影。
        const timeline = await until(
          async () => (await api('GET', `${adminPath}/timeline`)).data,
          (value) => value.commands.some((c: any) => c.id === commandId),
        );
        assert.equal(
          timeline.commands.find((c: any) => c.id === commandId).actor,
          'HUMAN',
        );
        assert.ok(!JSON.stringify(timeline).includes('fixture-only'));
        assert.equal(
          (await api('GET', `${adminPath}/timeline?after=${commandId}`)).status,
          200,
        );

        assert.equal(
          (await api('GET', `/v1/tasks/${definition.taskId}`)).data
            .executions[0].action_count,
          0,
        );
        assert.equal(
          (
            await api(
              'POST',
              `/v1/executions/${execution.id}/commands`,
              {
                type: 'execution.command',
                commandId: randomUUID(),
                command: input.command,
                timeoutMs: 1000,
                controlRevision: 1,
              },
              execution.leaseToken,
            )
          ).status,
          403,
        );
        // 范围：Cookie 沿用 HITL 身份、同源范围和去重，但不消耗 Agent 预算；节点为协议夹具，不代表真实登录成功。
        const cookie = {
          type: 'browser.cookies.set',
          url: definition.target.url,
          name: 'token',
          value: 'fixture-cookie-only',
          httpOnly: true,
        };
        const cookieId = randomUUID();
        for (let i = 1; i <= 2; i++) {
          first.ws.send(
            JSON.stringify({
              type: 'command',
              commandId: cookieId,
              command: cookie,
            }),
          );
          await until(
            async () => first.messages,
            (rows) =>
              rows.filter(
                (m) =>
                  m.type === 'result' &&
                  m.commandId === cookieId &&
                  m.status === 'SUCCEEDED',
              ).length === i,
          );
        }
        assert.equal(node.calls.get(cookieId), 1);
        assert.equal(
          (await api('GET', `/v1/tasks/${definition.taskId}`)).data
            .executions[0].action_count,
          0,
        );
        assert.ok(!JSON.stringify(first.messages).includes(cookie.value));
        assert.equal(
          (
            await api(
              'POST',
              `/v1/executions/${execution.id}/commands`,
              {
                type: 'execution.command',
                commandId: randomUUID(),
                command: cookie,
                timeoutMs: 1000,
                controlRevision: 1,
              },
              execution.leaseToken,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await api('POST', `/v1/admin/executions/${execution.id}/commands`, {
              type: 'execution.command',
              commandId: randomUUID(),
              command: { ...cookie, url: 'https://other.example/' },
              timeoutMs: 1000,
              controlRevision: 1,
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await api('POST', `/v1/admin/executions/${execution.id}/commands`, {
              type: 'execution.command',
              commandId: randomUUID(),
              command: cookie,
              timeoutMs: 1000,
              controlRevision: 0,
            })
          ).status,
          409,
        );
        // 范围：导航与刷新沿用原会话、去重和预算；节点是协议夹具。
        for (const command of [
          {
            type: 'browser.act',
            action: 'navigate',
            target: 'https://example.com/referral',
          },
          { type: 'browser.act', action: 'reload' },
        ]) {
          const navigationId = randomUUID();
          for (let attempt = 1; attempt <= 2; attempt++) {
            first.ws.send(
              JSON.stringify({
                type: 'command',
                commandId: navigationId,
                command,
              }),
            );
            await until(
              async () => first.messages,
              (rows) =>
                rows.filter(
                  (m) =>
                    m.type === 'result' &&
                    m.commandId === navigationId &&
                    m.status === 'SUCCEEDED',
                ).length === attempt,
            );
          }
          assert.equal(node.calls.get(navigationId), 1);
        }
        assert.equal(
          (await api('GET', `/v1/tasks/${definition.taskId}`)).data
            .executions[0].action_count,
          0,
        );
        // 无效目的地不派发节点命令，处理者可继续修正地址。
        const invalidNavigation = randomUUID();
        first.ws.send(
          JSON.stringify({
            type: 'command',
            commandId: invalidNavigation,
            command: {
              type: 'browser.act',
              action: 'navigate',
              target: 'javascript:alert(1)',
            },
          }),
        );
        await until(
          async () => first.messages,
          (rows) => rows.some((m) => m.code === 'HITL_NAVIGATION'),
        );
        assert.equal(node.calls.has(invalidNavigation), false);
        assert.equal(first.ws.readyState, WebSocket.OPEN);
        // 断开重进保留同一浏览器与人工状态，但不自动重放输入。
        first.ws.close();
        await new Promise<void>((resolve) =>
          first.ws.once('close', () => resolve()),
        );
        let resumed = await connect();
        await until(
          async () => resumed.messages,
          (rows) => rows.some((m) => m.type === 'frame'),
        );
        // 范围：旧保存故障不再参与交还，完成后恢复控制且不派发 auth.save；不验证真实浏览器。
        node.authSaveFailure = true;
        resumed.ws.send(
          JSON.stringify({ type: 'complete', confirmedItems: [0, 1] }),
        );
        await until(
          async () => resumed.messages,
          (rows) => rows.some((m) => m.type === 'completed'),
        );
        // 节点先通知页面完成，再异步回传控制命令结果；等待控制面确认，不能把消息到达当作事务提交。
        const view = await until(
          async () =>
            (
              await api(
                'GET',
                `/v1/executions/${execution.id}`,
                undefined,
                execution.leaseToken,
              )
            ).data,
          (state) => state.controlMode === 'AUTO',
        );
        assert.equal(
          resumed.messages.find((m) => m.type === 'completed')?.authStatus,
          'disabled',
        );
        const saves = await sql.query(
          "SELECT id FROM pr_commands WHERE execution_id=$1 AND kind='browser.auth.save'",
          [execution.id],
        );
        assert.equal(saves.rowCount, 0);
        assert.equal(view.controlMode, 'AUTO');
        assert.equal(view.controlRevision, 2);
        assert.equal(
          (await api('GET', `${adminPath}/intervention`)).data.intervention,
          null,
        );
        const finished = await connect();
        await until(
          async () => finished.messages,
          (rows) => rows.some((m) => m.type === 'completed'),
        );
        assert.ok(!finished.messages.some((m) => m.type === 'frame'));
        // 新一轮介入不复活上一轮链接。
        await api('POST', `${adminPath}/intervene`, {
          type: 'execution.intervene',
          reason: '再次确认',
          controlRevision: 2,
        });
        const next = (await api('GET', `${adminPath}/intervention`)).data
          .intervention;
        assert.notEqual(next.id, link.id);
        const nextToken = next.path.split('/').at(-1);
        const { ws, messages } = await connectHitl(base, next.id, nextToken);
        sockets.push(ws);
        await until(
          async () => messages,
          (rows) => rows.some((m) => m.type === 'state'),
        );
        await worker.close();
        await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
        await until(
          async () => messages,
          (rows) => rows.some((m) => m.code === 'HITL_ENDED'),
        );
        await cleaned(definition.taskId);
      } finally {
        for (const ws of sockets) ws.terminate();
      }
    });

    // 范围：轮换暂停调度、旧凭据失效和相同配对回执恢复；不测试生产 TLS 或主机文件写入。
    await suite.test('节点凭据轮换和配对回执恢复', async () => {
      const node = await addNode('rotation');
      const permit = (await api('POST', `/v1/nodes/${node.id}/rotation`, {}))
        .data;
      const definition = task('rotation');
      await submit(definition);
      assert.equal(await claim(), null);
      const body = {
        type: 'node.pair',
        nodeId: node.id,
        pool: node.pool,
        pairingToken: permit.pairingToken,
      };
      const rotated = await api('POST', '/v1/nodes/pair', body);
      assert.equal(rotated.status, 200);
      assert.notEqual(rotated.data.token, node.token);
      assert.equal(
        (await api('POST', '/v1/nodes/pair', body)).data.token,
        rotated.data.token,
      );
      assert.equal(
        (await api('GET', '/v1/nodes/connect', undefined, node.token)).status,
        401,
      );
      node.token = rotated.data.token;
      await node.connect();
      const next = await until<{ id: string; leaseToken: string }>(
        claim,
        Boolean,
      );
      await ready(next);
      assert.equal(
        (await api('POST', `/v1/nodes/${node.id}/rotation`, {})).status,
        409,
      );
      await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
      await cleaned(definition.taskId);
    });

    // 范围：真实 PostgreSQL/HTTP/WebSocket 验证确认身份、跨交接复用及输入失效；账号与画面仍为节点夹具。
    await suite.test('认证版本独立于控制权且逐项确认跨交接保存', async (t) => {
      const node = await addNode('versioned-confirmation');
      const definition: VerificationTask = {
        ...(task(node.pool) as VerificationTask),
        environment: {
          id: 'fixture',
          nodePool: node.pool,
          allowIntervention: true,
          reuseAuth: true,
        },
        sessionPlan: {
          version: 1,
          mode: 'guest',
          preparationMs: 120000,
          requirements: [],
          candidates: [],
        },
        executionPlan: {
          version: 1,
          environment: {
            mode: 'guest',
            source: 'explicit',
            basis: [],
            resolverVersion: 1,
          },
          evidenceKinds: ['DOM'],
        },
      };
      await submit(definition);
      // 新计划不会派给旧 worker；已冻结旧任务的回归仍使用原 claim 分支。
      assert.equal(await claim(), null);
      const execution = await claim(true);
      assert.ok(execution);
      const worker = new SimulatedWorker(base, execution);
      t.after(() => worker.close());
      await ready(execution);
      const read = async () =>
        (
          await api(
            'GET',
            `/v1/executions/${execution.id}`,
            undefined,
            execution.leaseToken,
          )
        ).data;
      assert.deepEqual((await read()).environmentProof, {
        sessionId: execution.sessionId,
        initialState: 'empty',
        authRestored: false,
        reducedMotion: true,
      });
      assert.equal(
        node.sessions.get(execution.sessionId)!.command.type,
        'session.open',
      );
      assert.equal(
        (node.sessions.get(execution.sessionId)!.command as any).authState,
        undefined,
      );
      const adminPath = `/v1/admin/executions/${execution.id}`;
      const keys = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
      for (let round = 0; round < 3; round++) {
        const revision = round * 2;
        assert.equal(
          (
            await api(
              'POST',
              `/v1/executions/${execution.id}/intervene`,
              {
                type: 'execution.intervene',
                controlRevision: revision,
                reason: '确认当前条件',
                items: ['核实条件'],
                conditionKeys: [keys[round]],
              },
              execution.leaseToken,
            )
          ).status,
          200,
        );
        assert.equal(
          (
            await api(
              'POST',
              `/v1/executions/${execution.id}/control`,
              {
                type: 'execution.control',
                action: 'acknowledge',
                controlRevision: revision + 1,
              },
              execution.leaseToken,
            )
          ).status,
          200,
        );
        const link = (await api('GET', `${adminPath}/intervention`)).data
          .intervention;
        const { ws, messages } = await connectHitl(
          base,
          link.id,
          link.path.split('/').at(-1),
        );
        try {
          await until(
            () => messages,
            (rows) =>
              rows.some((m) => m.type === 'state' && m.mode === 'HUMAN'),
          );
          assert.deepEqual(
            messages.find((m) => m.type === 'state').conditionKeys,
            [keys[round]],
          );
          if (round === 2) {
            const commandId = randomUUID();
            const request = {
              type: 'execution.command',
              commandId,
              timeoutMs: 5000,
              controlRevision: revision + 1,
              command: { type: 'browser.input', action: 'press', value: 'Tab' },
            };
            assert.equal(
              (await api('POST', `${adminPath}/commands`, request)).status,
              202,
            );
            await until(read, (value) => value.authRevision === 1);
            await until(
              async () =>
                (
                  await sql.query(
                    'SELECT result FROM pr_commands WHERE id=$1',
                    [commandId],
                  )
                ).rows[0]?.result,
              Boolean,
            );
            assert.equal(
              (await api('POST', `${adminPath}/commands`, request)).status,
              202,
            );
            assert.equal((await read()).authRevision, 1);
            assert.equal((await read()).humanConfirmation, undefined);
          }
          ws.send(
            JSON.stringify({
              type: 'complete',
              confirmedItems: [0],
              confirmedConditionKeys: [keys[round]],
            }),
          );
          await until(
            () => messages,
            (rows) => rows.some((m) => m.type === 'completed'),
          );
        } finally {
          ws.close();
        }
        const view = await read();
        assert.equal(view.authRevision, round === 2 ? 1 : 0);
        assert.deepEqual(
          view.humanConfirmation.conditionKeys.sort(),
          (round === 2 ? [keys[2]] : keys.slice(0, round + 1)).sort(),
        );
      }
      assert.equal(
        (
          await sql.query(
            "SELECT count(*) FROM pr_commands WHERE execution_id=$1 AND kind='browser.auth.save'",
            [execution.id],
          )
        ).rows[0].count,
        '0',
      );
      await worker.close();
      await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
      await cleaned(definition.taskId);
    });

    // 范围：网络能力路由、JSON 证据摘要与登录槽并发初始化；浏览器存储和捕获由另一个真实引擎测试验证。
    await suite.test('网络证据归档与节点登录槽并发调度', async () => {
      const node = await addNode('network-auth', 2);
      node.networkEvidence = true;
      node.authState = true;
      node.heartbeat();
      await until(
        async () => (await api('GET', '/v1/nodes')).data.nodes,
        (rows) =>
          rows.some(
            (n: { id: string; capabilities: { authState: boolean } }) =>
              n.id === node.id && n.capabilities.authState,
          ),
      );
      const definition = {
        ...task('network-auth'),
        environment: {
          id: 'fixture',
          nodePool: 'network-auth',
          auth: { nodeId: node.id, stateId: 'account', restore: true },
        },
      };
      definition.acceptanceCriteria[0]!.evidenceKinds = ['NETWORK'];
      await submit(definition);
      const execution = await claim();
      await ready(execution);
      const second = { ...definition, taskId: randomUUID() };
      await submit(second);
      const concurrent = await claim();
      assert.ok(concurrent);
      await ready(concurrent);
      const observed = await command(execution, { type: 'browser.observe' });
      const reference = observed.result.data.artifactRefs.find(
        (ref: { kind: string }) => ref.kind === 'NETWORK',
      );
      assert.ok(reference);
      const content = await fetch(
        `${base}/v1/artifacts/${reference.artifactId}`,
        { headers: { authorization: `Bearer ${ADMIN}` } },
      );
      assert.match(content.headers.get('content-type')!, /application\/json/);
      const text = await content.text();
      assert.equal(
        createHash('sha256').update(text).digest('hex'),
        reference.sha256,
      );
      assert.equal(JSON.parse(text).requests[0].status, 200);
      await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
      await cleaned(definition.taskId);
      await api('POST', `/v1/tasks/${second.taskId}/cancel`);
      await cleaned(second.taskId);
    });

    // 范围：跨初始租约的 TRACE 采集协议、能力准入、哈希与文件格式、归属和下载；traceEvents 是夹具，不证明真实浏览器采集。
    await suite.test('TRACE 文件可靠交付并限制所属节点和执行', async (t) => {
      const node = new SimulatedNode(base, 'trace-fixture');
      nodes.push(node);
      await node.pair(ADMIN);
      const definition = task('trace-fixture');
      definition.acceptanceCriteria[0]!.evidenceKinds = ['DOM', 'TRACE'];
      await submit(definition);
      assert.equal(await claim(), null);
      node.trace = true;
      node.heartbeat();
      const execution = await until(claim, (value) => !!value);
      const worker = new SimulatedWorker(base, execution);
      t.after(() => worker.close());
      await ready(execution);
      await command(execution, { type: 'browser.trace', action: 'start' });
      // 采集过程超过初始租约，后续 observe/stop 必须由独立续约维持有效性。
      await delay(
        Math.max(0, Date.parse(execution.leaseExpiresAt) - Date.now()) +
          LEASE_BOUNDARY_MARGIN_MS,
      );
      const observed = await command(execution, { type: 'browser.observe' });
      const stopped = await command(execution, {
        type: 'browser.trace',
        action: 'stop',
      });
      const ref = stopped.result.data.artifactRefs[0];
      const upload = (
        bytes: Buffer,
        token = node.token,
        contentType = 'application/vnd.proofrun.trace+json',
      ) =>
        fetch(`${base}/v1/artifacts/${ref.artifactId}`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': contentType,
            'x-content-sha256': TRACE_HASH,
          },
          body: new Uint8Array(bytes),
        });
      assert.equal((await upload(TRACE, node.token, 'image/png')).status, 415);
      assert.equal((await upload(Buffer.from('{}'))).status, 422);
      assert.equal((await upload(TRACE, WORKER)).status, 401);
      assert.equal((await upload(TRACE)).status, 200);
      node.send({
        type: 'artifact.available',
        messageId: `artifact:${ref.artifactId}`,
        artifactId: ref.artifactId,
        sha256: TRACE_HASH,
      });
      await until(
        async () =>
          (
            await api(
              'GET',
              `/v1/executions/${execution.id}`,
              undefined,
              execution.leaseToken,
            )
          ).data.artifacts,
        (rows) =>
          rows.some(
            (a: { kind: string; state: string }) =>
              a.kind === 'TRACE' && a.state === 'AVAILABLE',
          ),
      );
      const response = await fetch(
        `${base}/v1/executions/${execution.id}/artifacts/${ref.artifactId}`,
        { headers: { authorization: `Bearer ${execution.leaseToken}` } },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), TRACE);
      const refs = [...observed.result.data.artifactRefs, ref];
      const report = {
        protocolVersion: '0.1',
        taskId: definition.taskId,
        lifecycle: 'COMPLETED',
        executionDisposition: 'EXECUTED',
        verdict: 'PASSED',
        summary: 'TRACE 交付协议夹具',
        criteria: [
          {
            criterionId: 'visible',
            verdict: 'PASSED',
            summary: '夹具验证归属与交付',
            evidenceRefs: refs.map((r: { artifactId: string }) => r.artifactId),
          },
        ],
        artifacts: refs.map(
          (r: { artifactId: string; kind: string; sha256: string }) => ({
            id: r.artifactId,
            kind: r.kind,
            sha256: r.sha256,
            uri: `${base}/v1/artifacts/${r.artifactId}`,
          }),
        ),
      };
      await worker.close();
      assert.equal(
        (
          await api(
            'POST',
            `/v1/executions/${execution.id}/complete`,
            { type: 'execution.complete', report },
            execution.leaseToken,
          )
        ).status,
        200,
      );
      await cleaned(definition.taskId);
    });

    // 范围：重跑复制配置、重复请求幂等、旧记录不变与对照成对重建；不启动真实模型或浏览器。
    await suite.test('任务重跑保留历史并防止重复创建', async () => {
      const original = task(`offline-${randomUUID()}`);
      await submit(original);
      await api('POST', `/v1/tasks/${original.taskId}/cancel`, {});
      const runId = `rerun-${randomUUID()}`;
      const path = `/v1/tasks/${original.taskId}/rerun`;
      assert.equal((await api('POST', path, { runId }, WORKER)).status, 401);
      assert.equal(
        (await api('POST', path, { runId: original.taskId })).status,
        400,
      );
      assert.equal(
        (await api('POST', path, { runId, extra: true })).status,
        400,
      );
      const first = await api('POST', path, { runId });
      assert.equal(first.status, 202);
      assert.deepEqual((await api('POST', path, { runId })).data, first.data);
      const fresh = (await api('GET', `/v1/tasks/${runId}`)).data;
      assert.deepEqual(fresh.definition, {
        ...original,
        taskId: runId,
        executionMode: 'llm',
      });
      assert.equal(fresh.state, 'QUEUED');
      assert.equal(fresh.report, null);
      assert.equal(
        (await api('GET', `/v1/tasks/${original.taskId}`)).data.state,
        'CANCELLED',
      );
      const retired = await api(
        'POST',
        `/v1/tasks/${original.taskId}/compare`,
        { comparisonId: `pair-${randomUUID()}` },
      );
      assert.equal(retired.status, 410);
      assert.equal(retired.data.code, 'EXECUTION_MODE_RETIRED');
      await api('POST', `/v1/tasks/${runId}/cancel`, {});
    });

    // 范围：已关闭执行的保留窗口、预览与清理、任务身份不复用；不模拟磁盘损坏。
    await suite.test('证据清理保留任务身份且不碰未关闭会话', async () => {
      const old = (
        await sql.query(
          `SELECT t.id,e.id AS execution_id FROM pr_tasks t JOIN pr_executions e ON e.task_id=t.id JOIN pr_sessions s ON s.execution_id=e.id WHERE s.closure_verified AND EXISTS(SELECT 1 FROM pr_artifacts a WHERE a.execution_id=e.id) LIMIT 1`,
        )
      ).rows[0];
      assert.ok(old);
      await sql.query(
        "UPDATE pr_tasks SET finished_at=clock_timestamp()-interval '40 days' WHERE id=$1",
        [old.id],
      );
      await app.close();
      const maintenance = new Database(url.toString());
      try {
        await maintenance.start();
        const preview = await retain(
          maintenance,
          config.artifactDirectory,
          30,
          false,
        );
        assert.ok(preview.tasks.includes(old.id));
        assert.ok(
          (
            await sql.query(
              'SELECT 1 FROM pr_artifacts WHERE execution_id=$1',
              [old.execution_id],
            )
          ).rowCount,
        );
        await retain(maintenance, config.artifactDirectory, 30, true);
        assert.equal(
          (
            await sql.query(
              'SELECT 1 FROM pr_artifacts WHERE execution_id=$1',
              [old.execution_id],
            )
          ).rowCount,
          0,
        );
        assert.ok(
          (
            await sql.query('SELECT archived_at FROM pr_tasks WHERE id=$1', [
              old.id,
            ])
          ).rows[0].archived_at,
        );
        assert.ok(
          (
            await sql.query('SELECT 1 FROM pr_commands WHERE execution_id=$1', [
              old.execution_id,
            ])
          ).rowCount,
        );
      } finally {
        await maintenance.close();
      }
    });
  } finally {
    for (const node of nodes) node.close();
    await app.close();
    await sql.end();
    // 等待服务端处理连接关闭，避免强制删库向刚结束的测试连接发送异步错误。
    await until(
      async () =>
        Number(
          (
            await adminDb.query(
              'SELECT count(*) AS count FROM pg_stat_activity WHERE datname=$1',
              [databaseName],
            )
          ).rows[0].count,
        ),
      (count) => count === 0,
    );
    await adminDb.query(`DROP DATABASE ${databaseName}`);
    await adminDb.end();
    await rm(root, { recursive: true, force: true });
  }
});
