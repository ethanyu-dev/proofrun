import WebSocket from 'ws';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import pg from 'pg';
import { retain } from '../src/maintenance.js';
import { Database } from '../src/db.js';
import { sessionAuth } from '../src/modules/scheduling/auth.js';
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
  type VerificationTask,
} from '@proofrun/contracts';
import {
  PNG,
  PNG_HASH,
  TRACE,
  TRACE_HASH,
  SimulatedNode,
  SimulatedWorker,
  task,
  until,
} from './fixture.js';

/** 测试凭据只用于新建的临时数据库和回环监听。 */
const ADMIN = 'proofrun-admin-integration-only-credential';
const WORKER = 'proofrun-worker-integration-only-credential';
/** 明确跨越初始租约边界；不改变控制面配置或轮询超时。 */
const LEASE_BOUNDARY_MARGIN_MS = 100;

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
  const addNode = async (pool: string, capacity = 1) => {
    const node = new SimulatedNode(base, pool, capacity);
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
        { type: 'worker.claim', workerId: randomUUID(), structuredSteps },
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
    // 范围：真实 PostgreSQL 批量事务、同站点任务独立、逐步证据和清理顺序；节点为协议夹具，不执行业务浏览器。
    await suite.test('v2 批量原子接收、独立任务与关联清理', async () => {
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
      const second = await claim(true);
      const independent = await claim(true);
      assert.equal(first.task.taskId, 'case-v2-v2-first');
      assert.equal(second.task.taskId, 'case-v2-v2-second');
      assert.equal(independent.task.taskId, 'case-v2-v2-independent');
      assert.notEqual(first.task.resourceKey, second.task.resourceKey);
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
        'PENDING',
      );
      assert.equal(await claim(true), null);
      node.ignoreClose = false;
      for (const id of [...node.sessions.keys()]) node.closed(id);
      await until(
        async () =>
          (await api('GET', '/v2/cases/v2-first')).data.cleanup.status,
        (state) => state === 'QUEUED',
      );
      // 关闭确认和空闲心跳独立到达，清理入队不代表容量心跳已刷新。
      const cleanup = await until(
        () => claim(true),
        (value) => value !== null,
      );
      assert.equal(cleanup.task.parentTaskId, first.task.taskId);
      assert.equal(cleanup.task.purpose, 'cleanup');
      assert.deepEqual(cleanup.task.acceptanceCriteria, []);
      assert.equal(await claim(true), null);
      await complete(cleanup);
      await until(
        async () =>
          (await api('GET', '/v2/cases/v2-first')).data.cleanup.status,
        (state) => state === 'COMPLETED',
      );
      const final = (await api('GET', '/v2/cases/v2-first')).data;
      assert(
        validateCaseResultV2(final),
        JSON.stringify(validateCaseResultV2.errors),
      );
      assert.equal(final.result!.outcome, 'PASSED');
      assert.equal(final.cleanup!.result!.outcome, 'PASSED');
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

    // 范围：真实 HTTP、数据库和调度器验证清理故障不阻塞新 case、幂等重提不重跑；导航故障由节点夹具注入，不证明网络或浏览器行为。
    await suite.test('v2 历史清理失败后同站点的新任务仍可领取', async () => {
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
      node.unknownWrite = true;
      await command(first, {
        type: 'browser.act',
        action: 'navigate',
        target: input.entry,
      });
      await cleaned(first.task.taskId);
      await until(
        async () =>
          (await api('GET', `/v2/cases/${input.caseId}`)).data.cleanup.status,
        (state) => state === 'QUEUED',
      );
      // 关闭确认和空闲心跳独立到达，清理入队不代表容量心跳已刷新。
      const cleanup = await until(
        () => claim(true),
        (value) => value !== null,
      );
      assert.equal(cleanup.task.parentTaskId, first.task.taskId);
      assert.equal(cleanup.task.resourceKey, first.task.resourceKey);
      await ready(cleanup);
      await command(cleanup, {
        type: 'browser.act',
        action: 'navigate',
        target: input.entry,
      });
      await cleaned(cleanup.task.taskId);
      const failed = (await api('GET', `/v2/cases/${input.caseId}`)).data;
      assert.equal(failed.status, 'ERROR');
      assert.equal(failed.cleanup.status, 'ERROR');

      const repeated = await api('POST', '/v2/cases', [input]);
      assert.equal(repeated.status, 202);
      assert.equal(repeated.data[0].status, 'ERROR');
      assert.equal(repeated.data[0].cleanup.status, 'ERROR');
      assert.equal(await claim(true), null);

      node.unknownWrite = false;
      const next = { ...input, caseId: 'v2-after-failed-cleanup', cleanup: [] };
      assert.equal((await api('POST', '/v2/cases', [next])).status, 202);
      const execution = await claim(true);
      assert.ok(execution, '旧清理失败不能阻塞新的 caseId');
      assert.equal(execution.task.taskId, `case-v2-${next.caseId}`);
      assert.notEqual(execution.task.resourceKey, first.task.resourceKey);
      assert.equal(
        (await api('GET', `/v2/cases/${input.caseId}`)).data.cleanup.status,
        'ERROR',
      );
      await api('POST', `/v2/cases/${next.caseId}/cancel`);
      await cleaned(execution.task.taskId);
      await api('POST', `/v1/nodes/${node.id}/revoke`);
      node.close();
    });

    // 范围：真实 HTTP 与数据库验证 case 权限、入口必填、描述映射、并发幂等和取消；不运行模型或浏览器。
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
    await suite.test('域名绑定固定节点并保留容量约束', async () => {
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

    // 范围：真实事务中的并发领取和资源预留；关闭事实来自协议夹具，不是进程探测。
    await suite.test('并发领取不超配，清理后队列继续', async () => {
      await addNode('capacity');
      await addNode('capacity');
      const definitions = [
        task('capacity'),
        task('capacity'),
        task('capacity'),
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
      const sockets: WebSocket[] = [];
      const connect = async (credential = token) => {
        const ws = new WebSocket(
          `${base.replace(/^http/, 'ws')}/v1/hitl/connect`,
          { origin: base },
        );
        sockets.push(ws);
        const messages: any[] = [];
        ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
        ws.on('error', () => {});
        await new Promise<void>((resolve) => ws.once('open', resolve));
        ws.send(
          JSON.stringify({
            type: 'authenticate',
            id: link.id,
            token: credential,
          }),
        );
        return { ws, messages };
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
        const duplicate = await connect();
        await until(
          async () => duplicate.messages,
          (rows) => rows.some((m) => m.code === 'HITL_OCCUPIED'),
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
        assert.equal(
          (await api('GET', `/v1/tasks/${definition.taskId}`)).data
            .executions[0].action_count,
          1,
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
        // 范围：保存失败不得恢复自动控制；人工重连后可重试确定未执行的保存，不代表真实磁盘故障。
        node.authSaveFailure = true;
        resumed.ws.send(JSON.stringify({ type: 'complete' }));
        await until(
          async () => resumed.messages,
          (rows) => rows.some((m) => m.code === 'AUTH_SAVE_FAILED'),
        );
        const paused = (
          await api(
            'GET',
            `/v1/executions/${execution.id}`,
            undefined,
            execution.leaseToken,
          )
        ).data;
        assert.equal(paused.controlMode, 'HUMAN');
        await until(
          async () => resumed.ws.readyState,
          (state) => state === WebSocket.CLOSED,
        );
        node.authSaveFailure = false;
        resumed = await connect();
        await until(
          async () => resumed.messages,
          (rows) => rows.some((m) => m.type === 'frame'),
        );
        resumed.ws.send(JSON.stringify({ type: 'complete' }));
        await until(
          async () => resumed.messages,
          (rows) => rows.some((m) => m.type === 'completed'),
        );
        const view = (
          await api(
            'GET',
            `/v1/executions/${execution.id}`,
            undefined,
            execution.leaseToken,
          )
        ).data;
        assert.equal(
          resumed.messages.find((m) => m.type === 'completed')?.authStatus,
          'saved',
        );
        const saves = await sql.query(
          "SELECT id FROM pr_commands WHERE execution_id=$1 AND kind='browser.auth.save'",
          [execution.id],
        );
        assert.equal(saves.rowCount, 2);
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
        const ws = new WebSocket(
          `${base.replace(/^http/, 'ws')}/v1/hitl/connect`,
          { origin: base },
        );
        sockets.push(ws);
        const messages: any[] = [];
        ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
        ws.on('error', () => {});
        await new Promise<void>((resolve) => ws.once('open', resolve));
        ws.send(
          JSON.stringify({
            type: 'authenticate',
            id: next.id,
            token: nextToken,
          }),
        );
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

    // 范围：真实 HTTP/数据库的路由覆盖、偏好复用及离线回退；节点仅检查恢复协议，不证明真实登录文件或业务登录成功。
    await suite.test(
      '自动登录偏好随路由更新且旧节点不可用不阻塞新任务',
      async () => {
        const oldNode = await addNode('auth-route', 2);
        const newNode = await addNode('auth-route', 2);
        const definition = {
          ...task(oldNode.pool),
          environment: {
            id: 'fixture',
            nodePool: oldNode.pool,
            reuseAuth: true,
          },
          target: { url: 'https://auth-route.example.test' },
        };
        const auth = sessionAuth(definition as VerificationTask)!;
        await sql.query(
          'INSERT INTO pr_auth_bindings(scope,node_id) VALUES($1,$2)',
          [auth.stateId, oldNode.id],
        );
        await api('POST', `/v1/nodes/${newNode.id}/routing`, {
          domains: ['auth-route.example.test'],
          revision: 0,
        });
        await submit(definition);
        const first = await claim();
        assert.equal(first.nodeId, newNode.id);
        await ready(first);
        const opened = newNode.sessions.get(first.sessionId)!.command;
        assert.equal(opened.type, 'session.open');
        if (opened.type === 'session.open') {
          // 自动槽在新节点无文件时允许空状态，存在文件时仍恢复；不改变节点端的损坏文件处理。
          assert.deepEqual(opened.authState, auth);
          assert.equal(opened.authState?.restore, true);
          assert.equal(opened.authState?.restoreIfPresent, true);
        }
        assert.equal(
          (
            await sql.query(
              'SELECT node_id FROM pr_auth_bindings WHERE scope=$1',
              [auth.stateId],
            )
          ).rows[0].node_id,
          newNode.id,
        );
        await api('POST', `/v1/nodes/${newNode.id}/routing`, {
          domains: [],
          revision: 1,
        });
        // 新节点已有一个会话，旧节点空闲；无路由时仍优先复用可用登录节点。
        const secondDefinition = { ...definition, taskId: randomUUID() };
        await submit(secondDefinition);
        const second = await claim();
        assert.equal(second.nodeId, newNode.id);
        // 偏好节点容量耗尽时，独立任务可以使用另一个节点。
        const thirdDefinition = { ...definition, taskId: randomUUID() };
        await submit(thirdDefinition);
        const third = await claim();
        assert.equal(third.nodeId, oldNode.id);
        for (const d of [definition, secondDefinition, thirdDefinition]) {
          await api('POST', `/v1/tasks/${d.taskId}/cancel`);
          await cleaned(d.taskId);
        }
        oldNode.close();
        await until(
          async () =>
            (await api('GET', '/v1/nodes')).data.nodes.find(
              (n: { id: string }) => n.id === oldNode.id,
            ).online,
          (online) => !online,
        );
        const nextDefinition = { ...definition, taskId: randomUUID() };
        await submit(nextDefinition);
        const next = await until(
          () => claim(),
          (value) => value !== null,
        );
        assert.equal(next.nodeId, newNode.id);
        await api('POST', `/v1/tasks/${nextDefinition.taskId}/cancel`);
        await cleaned(nextDefinition.taskId);
      },
    );

    // 范围：真实领取事务保证同轮快照节点不可迁移，独立任务可换节点，释放后仍沿用本轮节点；不验证浏览器快照内容。
    await suite.test('自动偏好更新不能拆散已开始的对照组', async () => {
      const firstNode = await addNode('auth-pinned');
      const otherNode = await addNode('auth-pinned', 2);
      const definition = {
        ...task(firstNode.pool),
        executionMode: 'parallel',
        environment: {
          id: 'fixture',
          nodePool: firstNode.pool,
          reuseAuth: true,
        },
        target: { url: 'https://auth-pinned.example.test' },
      };
      const scope = sessionAuth(definition as VerificationTask)!.stateId;
      await sql.query(
        'INSERT INTO pr_auth_bindings(scope,node_id) VALUES($1,$2)',
        [scope, firstNode.id],
      );
      await submit(definition);
      // 同时领取允许一次事务因短锁而让步，但不能把两组分散到两个节点。
      const claims = (await Promise.all([claim(), claim()])).filter(Boolean);
      assert.equal(claims.length, 1);
      const first = claims[0];
      assert.equal(first.nodeId, firstNode.id);
      await ready(first);
      const secondId = `${definition.taskId}-${first.task.comparison.arm === 'llm' ? 'jev' : 'llm'}`;
      assert.equal(await claim(), null);
      assert.equal(
        (await api('GET', `/v1/tasks/${secondId}`)).data.queueReason.code,
        'NODE_CAPACITY',
      );
      await api('POST', `/v1/nodes/${otherNode.id}/routing`, {
        domains: ['auth-pinned.example.test'],
        revision: 0,
      });
      assert.equal(await claim(), null);
      assert.equal(
        (await api('GET', `/v1/tasks/${secondId}`)).data.queueReason.code,
        'COMPARISON_NODE_CONFLICT',
      );
      const independent = {
        ...definition,
        taskId: randomUUID(),
        executionMode: 'llm',
      };
      await submit(independent);
      const moved = await claim();
      assert.equal(moved.task.taskId, independent.taskId);
      assert.equal(moved.nodeId, otherNode.id);
      assert.equal(
        (
          await sql.query(
            'SELECT node_id FROM pr_auth_bindings WHERE scope=$1',
            [scope],
          )
        ).rows[0].node_id,
        otherNode.id,
      );
      await api('POST', `/v1/tasks/${independent.taskId}/cancel`);
      await cleaned(independent.taskId);
      await api('POST', `/v1/nodes/${otherNode.id}/routing`, {
        domains: [],
        revision: 1,
      });
      assert.equal(await claim(), null);
      await api('POST', `/v1/tasks/${first.task.taskId}/cancel`);
      await cleaned(first.task.taskId);
      const second = await until(
        () => claim(),
        (value) => value !== null,
      );
      assert.equal(second.task.taskId, secondId);
      assert.equal(second.nodeId, firstNode.id);
      const snapshots = await sql.query(
        'SELECT s.auth_state FROM pr_executions e JOIN pr_sessions s ON s.execution_id=e.id WHERE e.task_id=ANY($1::text[])',
        [[first.task.taskId, secondId]],
      );
      assert.equal(snapshots.rows.length, 2);
      assert.deepEqual(
        snapshots.rows[0].auth_state,
        snapshots.rows[1].auth_state,
      );
      assert.equal(
        (await api('GET', `/v1/tasks/${secondId}`)).data.queueReason,
        null,
      );
      await api('POST', `/v1/tasks/${secondId}/cancel`);
      await cleaned(secondId);
    });

    // 范围：真实调度和数据库绑定、同轮两组初始快照身份、重跑沿用可用节点偏好；节点文件和登录由独立引擎测试覆盖。
    await suite.test('自动登录快照允许并行且重跑沿用节点偏好', async () => {
      const node = await addNode('auth-pair', 2);
      const definition = {
        ...task('auth-pair'),
        executionMode: 'parallel',
        environment: {
          id: 'fixture',
          nodePool: 'auth-pair',
          allowIntervention: true,
        },
      };
      const submitted = await api('POST', '/v1/tasks', definition);
      assert.equal(submitted.status, 202);
      const first = await claim();
      const second = await claim();
      assert.ok(first && second);
      await ready(first);
      await ready(second);
      const opened = [...node.sessions.values()].map((s) => s.command);
      assert.equal(opened.length, 2);
      assert.ok(opened.every((c) => c.type === 'session.open'));
      const configs = opened.map((c) =>
        c.type === 'session.open' ? c.authState : undefined,
      );
      assert.deepEqual(configs[0], configs[1]);
      assert.equal(configs[0]?.restoreIfPresent, true);
      const slots = await sql.query(
        'SELECT node_id FROM pr_auth_bindings WHERE scope=$1',
        [configs[0]?.stateId],
      );
      assert.equal(slots.rows[0].node_id, node.id);
      for (const arm of ['llm', 'jev']) {
        await api('POST', `/v1/tasks/${definition.taskId}-${arm}/cancel`);
        await cleaned(`${definition.taskId}-${arm}`);
      }
      const rerunId = `auth-rerun-${randomUUID()}`;
      const rerun = await api(
        'POST',
        `/v1/tasks/${definition.taskId}-llm/rerun`,
        { runId: rerunId },
      );
      assert.equal(rerun.status, 202);
      // 会话关闭回执与下一次空闲心跳分别到达，领取允许暂时为空；不以即时容量推断节点已刷新。
      const next = await until(
        () => claim(),
        (value) => value !== null,
      );
      await ready(next);
      const current = [...node.sessions.values()][0]!.command;
      assert.equal(current.type, 'session.open');
      if (current.type === 'session.open') {
        assert.equal(current.authState?.stateId, configs[0]?.stateId);
        assert.notEqual(current.authState?.snapshotId, configs[0]?.snapshotId);
      }
      for (const arm of ['llm', 'jev']) {
        await api('POST', `/v1/tasks/${rerunId}-${arm}/cancel`);
        await cleaned(`${rerunId}-${arm}`);
      }
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

    // 范围：真实数据库验证三种创建方式、幂等、跨模式冲突和单组重跑；无真实模型或浏览器。
    await suite.test('创建时选择执行模式并保持不可变任务身份', async () => {
      const base = task(`offline-${randomUUID()}`);
      for (const executionMode of ['llm', 'jev'] as const) {
        const definition = {
          ...base,
          taskId: `${executionMode}-${randomUUID()}`,
          executionMode,
        };
        const first = await api('POST', '/v1/tasks', definition);
        assert.equal(first.status, 202);
        assert.equal(first.data.id, definition.taskId);
        assert.equal(first.data.definition.executionMode, executionMode);
        assert.equal(first.data.definition.comparison, undefined);
        assert.equal(
          (await api('POST', '/v1/tasks', definition)).data.id,
          definition.taskId,
        );
        assert.equal(
          (
            await api('POST', '/v1/tasks', {
              ...definition,
              executionMode: 'parallel',
            })
          ).status,
          409,
        );
        const runId = `single-rerun-${randomUUID()}`;
        assert.equal(
          (await api('POST', `/v1/tasks/${definition.taskId}/rerun`, { runId }))
            .status,
          202,
        );
        const rerun = (await api('GET', `/v1/tasks/${runId}`)).data;
        assert.equal(rerun.definition.executionMode, executionMode);
        assert.equal(rerun.definition.comparison, undefined);
        for (const id of [definition.taskId, runId])
          await api('POST', `/v1/tasks/${id}/cancel`, {});
      }
      const definition = {
        ...base,
        taskId: `parallel-${randomUUID()}`,
        executionMode: 'parallel',
      };
      const requests = await Promise.all([
        api('POST', '/v1/tasks', definition),
        api('POST', '/v1/tasks', definition),
      ]);
      for (const result of requests) {
        assert.equal(result.status, 202);
        assert.equal(result.data.id, `${definition.taskId}-llm`);
      }
      const pair = (
        await api('GET', `/v1/tasks/${requests[0].data.id}/comparison`)
      ).data.comparison;
      assert.deepEqual(
        pair.arms.map((arm: any) => arm.definition.executionMode),
        ['llm', 'jev'],
      );
      assert.equal(
        (await api('GET', `/v1/tasks/${definition.taskId}`)).status,
        404,
      );
      assert.equal(
        (
          await api('POST', '/v1/tasks', {
            ...definition,
            executionMode: 'llm',
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await api('POST', '/v1/tasks', {
            ...definition,
            objective: '另一个目标',
          })
        ).status,
        409,
      );
      for (const arm of pair.arms) {
        assert.deepEqual(arm.definition.budget, base.budget);
        assert.deepEqual(
          arm.definition.acceptanceCriteria,
          base.acceptanceCriteria,
        );
        await api('POST', `/v1/tasks/${arm.id}/cancel`, {});
      }
      const count = await sql.query(
        "SELECT count(*)::int AS count FROM pr_tasks WHERE definition->'comparison'->>'id'=$1",
        [definition.taskId],
      );
      assert.equal(count.rows[0].count, 2);
    });

    // 范围：第二组身份冲突时事务回滚、共享登录槽允许并行且超长身份被拒绝；不覆盖实际节点登录恢复。
    await suite.test('并行创建失败不能残留一组任务', async () => {
      const definition = {
        ...task(`offline-${randomUUID()}`),
        executionMode: 'parallel',
      };
      const conflicting = {
        ...definition,
        taskId: `${definition.taskId}-jev`,
        executionMode: 'llm',
      };
      await submit(conflicting);
      assert.equal((await api('POST', '/v1/tasks', definition)).status, 409);
      assert.equal(
        (await api('GET', `/v1/tasks/${definition.taskId}-llm`)).status,
        404,
      );
      await api('POST', `/v1/tasks/${definition.taskId}-jev/cancel`, {});
      assert.equal(
        (
          await api('POST', '/v1/tasks', {
            ...definition,
            taskId: 'x'.repeat(101),
          })
        ).status,
        422,
      );
      assert.equal(
        (
          await api('POST', '/v1/tasks', {
            ...definition,
            taskId: `${definition.taskId}-auth`,
            environment: {
              ...definition.environment,
              auth: { nodeId: 'node', stateId: 'slot', restore: true },
            },
          })
        ).status,
        202,
      );
      for (const arm of ['llm', 'jev'])
        await api(
          'POST',
          `/v1/tasks/${definition.taskId}-auth-${arm}/cancel`,
          {},
        );
      assert.equal(
        (
          await api('POST', '/v1/tasks', {
            ...definition,
            executionMode: 'unknown',
          })
        ).status,
        400,
      );
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
      assert.deepEqual(fresh.definition, { ...original, taskId: runId });
      assert.equal(fresh.state, 'QUEUED');
      assert.equal(fresh.report, null);
      assert.equal(
        (await api('GET', `/v1/tasks/${original.taskId}`)).data.state,
        'CANCELLED',
      );
      const pair = await api('POST', `/v1/tasks/${original.taskId}/compare`, {
        comparisonId: `pair-${randomUUID()}`,
      });
      const pairRun = await api('POST', `/v1/tasks/${pair.data.taskId}/rerun`, {
        runId: `pair-rerun-${randomUUID()}`,
      });
      assert.equal(pairRun.status, 202);
      const repeated = (
        await api('GET', `/v1/tasks/${pairRun.data.taskId}/comparison`)
      ).data.comparison;
      assert.deepEqual(
        repeated.arms.map((a: any) => a.definition.comparison.arm),
        ['llm', 'jev'],
      );
      for (const arm of repeated.arms) {
        assert.deepEqual(arm.definition.budget, original.budget);
        assert.deepEqual(
          arm.definition.acceptanceCriteria,
          original.acceptanceCriteria,
        );
        await api('POST', `/v1/tasks/${arm.id}/cancel`, {});
      }
      for (const id of [
        runId,
        pair.data.taskId,
        pair.data.taskId.replace(/-llm$/, '-jev'),
      ])
        await api('POST', `/v1/tasks/${id}/cancel`, {});
    });

    // 范围：两组原子创建、并发独立租约、只读画面认证与结束清理；帧由夹具产生，不代表真实浏览器验收。
    await suite.test('同任务两组并发与只读实时通道', async () => {
      const pool = `compare-${randomUUID()}`;
      await addNode(pool, 2);
      const original = task(pool);
      await submit(original);
      await api('POST', `/v1/tasks/${original.taskId}/cancel`, {});
      const comparisonId = `pair-${randomUUID()}`;
      const first = await api('POST', `/v1/tasks/${original.taskId}/compare`, {
        comparisonId,
        maxActions: 100,
      });
      assert.equal(first.status, 200);
      assert.deepEqual(
        (
          await api('POST', `/v1/tasks/${original.taskId}/compare`, {
            comparisonId,
            maxActions: 100,
          })
        ).data,
        first.data,
      );
      const pair = (
        await api('GET', `/v1/tasks/${first.data.taskId}/comparison`)
      ).data.comparison;
      assert.equal(pair.arms.length, 2);
      for (const arm of pair.arms) {
        assert.deepEqual(
          arm.definition.acceptanceCriteria,
          original.acceptanceCriteria,
        );
        assert.deepEqual(arm.definition.budget, {
          ...original.budget,
          maxActions: 100,
        });
      }
      // 范围：同一身份不能改变预算；无效预算不能创建任务，原始定义不受影响。
      assert.equal(
        (
          await api('POST', `/v1/tasks/${original.taskId}/compare`, {
            comparisonId,
            maxActions: 101,
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await api('POST', `/v1/tasks/${original.taskId}/compare`, {
            comparisonId: comparisonId + '-invalid',
            maxActions: 0,
          })
        ).status,
        400,
      );
      assert.deepEqual(
        (await api('GET', `/v1/tasks/${original.taskId}`)).data.definition
          .budget,
        original.budget,
      );
      const [a, b] = await Promise.all([claim(), claim()]);
      assert.ok(a && b);
      assert.notEqual(a.sessionId, b.sessionId);
      assert.equal(a.nodeId, b.nodeId);
      await Promise.all([ready(a), ready(b)]);
      const sockets = [a, b].map(
        (e) =>
          new WebSocket(base.replace(/^http/, 'ws') + '/v1/live/connect', {
            origin: base,
          }),
      );
      const frames = sockets.map(
        (socket, i) =>
          new Promise<void>((resolve, reject) => {
            socket.on('error', reject);
            socket.on('open', () =>
              socket.send(
                JSON.stringify({
                  type: 'authenticate',
                  executionId: [a, b][i].id,
                  token: ADMIN,
                }),
              ),
            );
            socket.on('message', (raw) => {
              if (JSON.parse(raw.toString()).type === 'frame') resolve();
            });
          }),
      );
      await Promise.race([
        Promise.all(frames),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('live frame timeout')), 4000),
        ),
      ]);
      const state = await sql.query(
        'SELECT control_mode FROM pr_executions WHERE id=ANY($1::text[])',
        [[a.id, b.id]],
      );
      assert.ok(state.rows.every((r) => r.control_mode === 'AUTO'));
      const bad = new WebSocket(
        base.replace(/^http/, 'ws') + '/v1/live/connect',
        { origin: base },
      );
      bad.on('open', () =>
        bad.send(
          JSON.stringify({
            type: 'authenticate',
            executionId: a.id,
            token: 'wrong',
          }),
        ),
      );
      assert.equal(
        await new Promise((resolve) =>
          bad.on('close', (code) => resolve(code)),
        ),
        4003,
      );
      // 已认证通道仍不接受输入，不能把观看权限转为浏览器写入。
      const closed = new Promise((resolve) =>
        sockets[0]!.on('close', (code) => resolve(code)),
      );
      sockets[0]!.send(
        JSON.stringify({
          type: 'command',
          command: { type: 'browser.input', action: 'click', x: 1, y: 1 },
        }),
      );
      assert.equal(await closed, 4003);
      for (const arm of pair.arms)
        await api('POST', `/v1/tasks/${arm.id}/cancel`, {});
      await Promise.all(
        pair.arms.map((arm: { id: string }) => cleaned(arm.id)),
      );
      for (const socket of sockets) socket.terminate();
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
