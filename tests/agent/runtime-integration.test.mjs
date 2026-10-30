import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/api/dist/app.js';
import { Database } from '../../apps/api/dist/db.js';
import { recoverLostRuntimes } from '../../apps/api/dist/modules/execution-runtime/supervisor.js';
import {
  SimulatedNode,
  task,
  until,
  PNG,
  PNG_HASH,
} from '../../apps/api/test/fixture.ts';
import { ControlClient } from '../../apps/agent/dist/client.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { execute } from '../../packages/execution-driver/dist/execution/runner.js';
import { executeRuntime } from '../../apps/agent/dist/runtime.js';
import { config as agentConfig, finish, modelServer } from './fixture.mjs';

const { default: pg } = await import(
  createRequire(
    new URL('../../apps/api/package.json', import.meta.url),
  ).resolve('pg')
);
const ADMIN = 'proofrun-runtime-admin-integration-only';
const WORKER = 'proofrun-runtime-worker-integration-only';

/** 通用浏览器目标属于要求账本，不制造验证验收项；事实仍由夹具提供。 */
function complete(context) {
  const value = finish(context);
  if (context.task.kind === 'browser')
    value.progress.requirements = context.state.requirements.map((item) => ({
      id: item.id,
      status: 'complete',
      summary: '夹具目标完成',
      evidenceRefs: context.page.artifactRefs.map((ref) => ref.artifactId),
    }));
  return value;
}

/** 范围：真实 API、数据库、HTTP 模型适配与共享执行器；节点及模型输出是夹具，不验收真实浏览器和模型判断。 */
test(
  '服务端共享运行时的兼容、幂等和失效闭环',
  { timeout: 120_000 },
  async (suite) => {
    assert.ok(process.env.PROOFRUN_TEST_DATABASE_URL, '需要独立测试数据库');
    const adminDb = new pg.Pool({
      connectionString: process.env.PROOFRUN_TEST_DATABASE_URL,
    });
    const name = `proofrun_runtime_${randomUUID().replaceAll('-', '')}`;
    await adminDb.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.PROOFRUN_TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    const root = await mkdtemp(join(tmpdir(), 'proofrun-runtime-test-'));
    const holder = createServer();
    await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const port = holder.address().port;
    await new Promise((resolve) => holder.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const config = {
      databaseUrl: url.toString(),
      adminToken: ADMIN,
      workerToken: WORKER,
      publicUrl: base,
      host: '127.0.0.1',
      port,
      artifactDirectory: join(root, 'artifacts'),
      workerLeaseMs: 1800,
      nodeLeaseMs: 2000,
      tickMs: 25,
      executionRuntimeVersion: 1,
      caseProfile: {
        environment: {
          id: 'fixture',
          nodePool: 'runtime',
          allowIntervention: false,
        },
        budget: { timeoutMs: 20000, maxActions: 20 },
        executionMode: 'llm',
        evidenceKinds: ['DOM'],
      },
    };
    const app = await buildApp(config, { logger: false });
    const db = new pg.Pool({ connectionString: url.toString() });
    const nodes = [];
    const api = async (method, path, body, token = ADMIN) => {
      const response = await fetch(base + path, {
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
      const response = await api(...args);
      assert(
        response.status >= 200 && response.status < 300,
        JSON.stringify(response),
      );
      return response.body;
    };
    const settings = {
      ...agentConfig,
      apiUrl: base,
      workerToken: WORKER,
      modelMs: 5000,
      maxContextChars: 30000,
    };
    const client = new ControlClient(settings);
    const runtimeConfig = Object.fromEntries(
      [
        'model',
        'vision',
        'commandMs',
        'evidenceMs',
        'maxTurns',
        'maxContextChars',
      ].map((key) => [key, settings[key]]),
    );
    /** 每个用例使用独立节点池；修改入队版本不会改变先前冻结的运行。 */
    const enqueue = async (version = 1, kind = 'verification') => {
      config.executionRuntimeVersion = version;
      const pool = randomUUID();
      const node = new SimulatedNode(base, pool, 4);
      nodes.push(node);
      node.fullProfile = true;
      const commands = [];
      const uploads = [];
      const original = node.execute.bind(node);
      node.execute = (command) => {
        commands.push(command);
        original(command);
        // 一像素图片仅用于验证上传、哈希校验和模型交付，不代表真实截图。
        for (const ref of node.results.get(command.commandId)?.data
          ?.artifactRefs ?? []) {
          if (ref.kind !== 'SCREENSHOT') continue;
          const uploading = (async () => {
            await until(
              async () =>
                (
                  await fetch(`${base}/v1/artifacts/${ref.artifactId}`, {
                    method: 'PUT',
                    headers: {
                      authorization: `Bearer ${node.token}`,
                      'content-type': 'image/png',
                      'x-content-sha256': PNG_HASH,
                    },
                    body: PNG,
                  })
                ).status,
              (status) => status === 200,
            );
            node.send({
              type: 'artifact.available',
              messageId: `artifact:${ref.artifactId}`,
              artifactId: ref.artifactId,
              sha256: PNG_HASH,
            });
          })();
          void uploading.catch(() => {});
          uploads.push(uploading);
        }
      };
      await node.pair(ADMIN);
      await until(
        () => ok('GET', '/v1/nodes'),
        (value) => value.nodes.some((row) => row.id === node.id && row.online),
      );
      const definition = task(pool, kind === 'vision');
      let id = definition.taskId;
      if (kind === 'hitl') definition.environment.allowIntervention = true;
      if (kind === 'verification' || kind === 'hitl' || kind === 'vision')
        await ok('POST', '/v1/tasks', definition);
      else {
        config.caseProfile.environment.nodePool = pool;
        if (kind === 'browser')
          await ok('POST', '/v1/browser-tasks', {
            taskId: id,
            url: definition.target.url,
            objective: definition.objective,
          });
        else {
          id = `case-v2-${id}`;
          await ok('POST', '/v2/cases', [
            {
              caseId: id.slice(8),
              platform: '共享执行回归夹具',
              entry: definition.target.url,
              session: { mode: 'guest' },
              steps: [
                {
                  stepId: 'setup',
                  type: 'setup',
                  url: definition.target.url,
                  exec_order: 1,
                  description: '准备测试页面',
                  policy: ['页面已准备'],
                  expected: [],
                },
                {
                  stepId: 'verify',
                  type: 'verification',
                  url: definition.target.url,
                  exec_order: 2,
                  description: '检查页面',
                  policy: [],
                  expected: ['页面可观察'],
                },
                ...(kind === 'parallel'
                  ? [
                      {
                        stepId: 'setup-2',
                        type: 'setup',
                        url: definition.target.url,
                        exec_order: 3,
                        description: '准备第二组',
                        policy: [],
                        expected: [],
                      },
                      {
                        stepId: 'verify-2',
                        type: 'verification',
                        url: definition.target.url,
                        exec_order: 4,
                        description: '检查第二组',
                        policy: [],
                        expected: ['页面可观察'],
                      },
                    ]
                  : []),
              ],
              cleanup: [
                {
                  stepId: 'cleanup',
                  url: definition.target.url,
                  exec_order: 5,
                  description: '恢复页面',
                  policy: [],
                  expected: [],
                },
              ],
            },
          ]);
        }
      }
      return { node, commands, id, uploads };
    };
    const stored = (id) => ok('GET', `/v1/tasks/${id}`);
    const closed = (id) =>
      until(
        () => stored(id),
        (value) =>
          value.executions.length > 0 &&
          value.executions.every((row) => row.closure_verified),
      );
    /** 同一脚本分别通过旧 HTTP 执行端和新服务端驱动，不对比较结果进行夹具回填。 */
    const run = async (
      version,
      kind,
      decide = complete,
      decorate = () => {},
    ) => {
      const fixture = await enqueue(version, kind);
      await decorate(fixture);
      const seen = [];
      const server = await modelServer(async (context, ...args) => {
        seen.push(context);
        return decide(context, ...args, { grant, control, fixture });
      });
      const agent = {
        ...settings,
        modelUrl: server.url,
        vision: kind === 'vision',
      };
      const control = new ControlClient(agent);
      const grant = await until(() => control.claim(), Boolean);
      assert.equal(grant.task.taskId, fixture.id);
      assert.equal(grant.runtimeVersion, version === 1 ? 1 : undefined);
      try {
        const report = await (version === 1 ? executeRuntime : execute)(
          agent,
          control,
          new ChatModel(agent),
          grant,
          new AbortController().signal,
        );
        const saved = await closed(fixture.id);
        assert.deepEqual(server.errors, []);
        await Promise.all(fixture.uploads);
        return {
          ...fixture,
          report,
          saved,
          seen,
          grant,
          control,
          requests: server.requests,
        };
      } finally {
        await server.close();
      }
    };
    await app.listen({ host: '127.0.0.1', port });
    try {
      // 范围：真实 API/数据库复现运行时先于准入回执创建的竞态，验证重排、旧令牌撤销和节点连接；资源拒绝来自协议夹具，不验收真实机器容量。
      await suite.test(
        '运行时已启动但节点拒绝准入时安全重排，不能连带断开节点',
        async () => {
          const fixture = await enqueue();
          const original = fixture.node.execute.bind(fixture.node);
          let opening;
          fixture.node.execute = (command) => {
            if (command.command.type === 'session.open' && !opening) {
              opening = command;
              return;
            }
            original(command);
          };
          const first = await until(() => client.claim(), Boolean);
          await until(() => opening, Boolean);
          await client.runtimeStart(first, runtimeConfig);
          assert.equal(
            (
              await db.query(
                'SELECT state FROM pr_execution_runtimes WHERE execution_id=$1',
                [first.id],
              )
            ).rows[0].state,
            'ACTIVE',
          );
          const socket = fixture.node.socket;
          fixture.node.rejectOpen = true;
          original(opening);
          await until(
            () => stored(fixture.id),
            (value) => value.state === 'QUEUED',
          );
          assert.equal(
            (
              await db.query(
                'SELECT 1 FROM pr_execution_runtimes WHERE execution_id=$1',
                [first.id],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            socket.readyState,
            1,
            '资源拒绝回执必须正常提交并保持网关连接',
          );
          assert.equal(
            (
              await api(
                'POST',
                `/v1/executions/${first.id}/runtime`,
                { type: 'start', config: runtimeConfig },
                first.leaseToken,
              )
            ).status,
            404,
          );
          await db.query(
            'UPDATE pr_nodes SET admission_retry_at=clock_timestamp() WHERE id=$1',
            [fixture.node.id],
          );
          const second = await until(() => client.claim(), Boolean);
          assert.notEqual(second.id, first.id);
          await until(
            () => stored(fixture.id),
            (value) => value.executions[0]?.session_state === 'ACTIVE',
          );
          // 重送旧回执只能命中 inbox 去重，不能删除或终止新执行。
          fixture.node.send(fixture.node.results.get(opening.commandId));
          assert.equal(
            (
              await api(
                'POST',
                `/v1/executions/${first.id}/heartbeat`,
                {},
                first.leaseToken,
              )
            ).status,
            404,
          );
          assert.equal((await stored(fixture.id)).executions[0].id, second.id);
          await ok('POST', `/v1/tasks/${fixture.id}/cancel`, {});
          await closed(fixture.id);
          assert.equal(socket.readyState, 1);
        },
      );

      // 范围：运行版本在入队时冻结、旧 worker 不抢新任务；没有启动模型或真实浏览器。
      await suite.test('领取协商和旧写入围栏', async () => {
        const fixture = await enqueue();
        config.executionRuntimeVersion = 0;
        const old = await ok(
          'POST',
          '/v1/worker/claim',
          {
            type: 'worker.claim',
            workerId: 'old',
            structuredSteps: true,
            stepBudgetVersion: 1,
            identityVersion: 2,
            profileTabsVersion: 1,
            executionPlanVersion: 1,
          },
          WORKER,
        );
        assert.equal(old.execution, null);
        const grant = await until(() => client.claim(), Boolean);
        assert.equal(grant.runtimeVersion, 1);
        for (const path of [
          'commands',
          'steps',
          'complete',
          'intervene',
          'control',
          'model-calls/fake',
        ]) {
          const denied = await api(
            'POST',
            `/v1/executions/${grant.id}/${path}`,
            {},
            grant.leaseToken,
          );
          assert.equal(denied.status, 409);
          assert.equal(denied.body.code, 'EXECUTION_RUNTIME_REQUIRED');
        }
        assert.equal(
          (
            await api(
              'POST',
              `/v1/executions/${grant.id}/runtime`,
              { type: 'start', config: runtimeConfig },
              'wrong',
            )
          ).status,
          401,
        );
        await closed(fixture.id);
      });
      // 范围：准备、policy 新观察、验收和清理顺序及统计一致；不将模拟证据解释成站点通过。
      for (const kind of ['verification', 'browser', 'case'])
        await suite.test(`${kind} 新旧执行行为等价`, async () => {
          const legacy = await run(0, kind);
          const runtime = await run(1, kind);
          const projection = ({ report, seen }) => ({
            disposition: report.executionDisposition,
            verdict: report.verdict,
            criteria: report.criteria.map((row) => [
              row.criterionId,
              row.verdict,
            ]),
            steps: report.steps?.map((row) => [
              row.stepId,
              row.phase,
              row.status,
            ]),
            actions: report.executionDetails.actions,
            modelCalls: report.executionDetails.modelCalls,
            promptTokens: report.executionDetails.promptTokens,
            completionTokens: report.executionDetails.completionTokens,
            phases: seen.map((context) => [
              context.task.stepId,
              context.state.phase,
            ]),
            browserOutcome: report.browserResult?.outcome,
          });
          assert.equal(
            runtime.report.executionDisposition,
            'EXECUTED',
            JSON.stringify(runtime.report),
          );
          assert.deepEqual(projection(runtime), projection(legacy));
          if (kind === 'case') {
            const prepare = runtime.seen.find(
              (row) =>
                row.task.stepId === 'setup' && row.state.phase === 'PREPARING',
            );
            const checking = runtime.seen.find(
              (row) =>
                row.task.stepId === 'setup' && row.state.phase === 'CHECKING',
            );
            assert(prepare && checking);
            assert.notEqual(
              prepare.page.observationId,
              checking.page.observationId,
            );
            assert.equal(runtime.seen.at(-1).task.stepId, 'cleanup');
          }
          const decisions = (
            await db.query(
              'SELECT * FROM pr_runtime_decisions WHERE execution_id=$1',
              [runtime.grant.id],
            )
          ).rows;
          assert.equal(
            decisions.length,
            runtime.report.executionDetails.modelCalls,
          );
          assert(
            decisions.every(
              (row) =>
                row.state === 'ACCEPTED' &&
                row.trace_start_done &&
                row.trace_finish_done,
            ),
          );
          const operations = (
            await db.query(
              'SELECT * FROM pr_runtime_operations WHERE execution_id=$1',
              [runtime.grant.id],
            )
          ).rows;
          assert(operations.length > 0);
          assert(
            operations.every((row) => row.state === 'FINISHED' && row.result),
          );
          const snapshot = (
            await db.query(
              'SELECT snapshot FROM pr_execution_runtimes WHERE execution_id=$1',
              [runtime.grant.id],
            )
          ).rows[0].snapshot;
          assert(snapshot && Object.keys(snapshot).length > 0);
        });
      // 范围：适配器采用不同模型时，请求与用量仍归属同一模型；HTTP 供应商和浏览器由夹具模拟。
      await suite.test('用量归属实际请求模型而非运行默认模型', async () => {
        const fixture = await enqueue();
        const server = await modelServer(finish);
        const agent = { ...settings, modelUrl: server.url };
        const control = new ControlClient(agent);
        const grant = await until(() => control.claim(), Boolean);
        const model = 'fixture-selected-model';
        assert.notEqual(model, agent.model);
        try {
          const report = await executeRuntime(
            agent,
            control,
            new ChatModel({ ...agent, model }),
            grant,
            new AbortController().signal,
          );
          assert.equal(report.verdict, 'PASSED');
          assert.deepEqual(report.executionDetails.modelUsage, [
            {
              model,
              calls: 1,
              promptTokens: 20,
              completionTokens: 10,
            },
          ]);
          await closed(fixture.id);
          assert.deepEqual(server.errors, []);
        } finally {
          await server.close();
        }
      });
      // 范围：真实附件上传、摘要校验、帧引用与模型图片传输；像素来自夹具，不证明业务页面取证。
      await suite.test('视觉上下文只存引用并交付经过校验的图片', async () => {
        const result = await run(1, 'vision');
        assert.equal(result.report.verdict, 'PASSED', result.report.summary);
        assert.equal(
          result.requests[0].messages[1].content[1].image_url.url,
          `data:image/png;base64,${PNG.toString('base64')}`,
        );
        const frames = (
          await db.query(
            'SELECT context FROM pr_runtime_decisions WHERE execution_id=$1',
            [result.grant.id],
          )
        ).rows;
        assert(
          frames.every((row) => row.context.imageArtifact.sha256 === PNG_HASH),
        );
        assert(!JSON.stringify(frames).includes(PNG.toString('base64')));
      });
      // 范围：重复/并发消息复用决定和命令身份，异体重送与跨执行拒绝；模型和节点仍为夹具。
      await suite.test('决定审计先行、并发幂等和版本冲突', async () => {
        let posted = 0;
        const fixture = await enqueue();
        const server = await modelServer(finish);
        const agent = { ...settings, modelUrl: server.url };
        const control = new ControlClient(agent);
        const grant = await until(() => control.claim(), Boolean);
        const original = control.runtimeMutation.bind(control);
        control.runtimeMutation = async (execution, id, body) => {
          const path = `/v1/executions/${execution.id}/runtime/decisions/${id}`;
          if (body.type === 'trace_start') {
            const early = await api(
              'POST',
              path,
              {
                type: 'decision',
                revision: body.revision,
                outcome: {
                  error: { code: 'INVALID_MODEL_DECISION', status: 0 },
                },
              },
              execution.leaseToken,
            );
            assert.equal(early.body.code, 'MODEL_TRACE_REQUIRED');
            const stale = await api(
              'POST',
              path,
              { ...body, revision: body.revision + 1 },
              execution.leaseToken,
            );
            assert.equal(stale.body.code, 'REVISION_CONFLICT');
            assert.equal((await api('POST', path, body, 'wrong')).status, 401);
          }
          await Promise.all([
            original(execution, id, body),
            original(execution, id, body),
          ]);
          if (body.type === 'decision') {
            posted++;
            const conflict = await api(
              'POST',
              path,
              {
                ...body,
                outcome: {
                  error: { code: 'INVALID_MODEL_DECISION', status: 0 },
                },
              },
              execution.leaseToken,
            );
            assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
          }
        };
        try {
          const report = await executeRuntime(
            agent,
            control,
            new ChatModel(agent),
            grant,
            new AbortController().signal,
          );
          assert.equal(report.verdict, 'PASSED');
          await closed(fixture.id);
          assert.equal(posted, server.requests.length);
          assert.equal(report.executionDetails.modelCalls, posted);
          const rows = (
            await db.query(
              'SELECT id FROM pr_model_calls WHERE execution_id=$1',
              [grant.id],
            )
          ).rows;
          assert.equal(rows.length, posted);
          assert(
            [...fixture.node.calls.values()].every((count) => count === 1),
          );
          const other = await enqueue();
          const otherGrant = await until(() => client.claim(), Boolean);
          const decision = (
            await db.query(
              'SELECT id,revision,outcome FROM pr_runtime_decisions WHERE execution_id=$1 LIMIT 1',
              [grant.id],
            )
          ).rows[0];
          const wrongOwner = await api(
            'POST',
            `/v1/executions/${otherGrant.id}/runtime/decisions/${decision.id}`,
            {
              type: 'decision',
              revision: Number(decision.revision),
              outcome: decision.outcome,
            },
            otherGrant.leaseToken,
          );
          assert.equal(wrongOwner.status, 404);
          await closed(other.id);
        } finally {
          await server.close();
        }
      });
      // 范围：不同分组的模型请求真实重叠、决定帧互不覆盖、清理在全部组结束后；浏览器 tab 仍由夹具模拟。
      await suite.test('并行分组领取独立决定帧且统一清理', async () => {
        const waiting = [];
        const result = await run(1, 'parallel', async (context) => {
          if (context.task.stepId.startsWith('verify'))
            await new Promise((resolve) => {
              waiting.push(resolve);
              if (waiting.length === 2) waiting.forEach((done) => done());
            });
          return complete(context);
        });
        assert.equal(waiting.length, 2);
        assert.equal(result.report.verdict, 'PASSED', result.report.summary);
        assert.equal(result.seen.at(-1).task.stepId, 'cleanup');
        const rows = (
          await db.query(
            'SELECT revision,state FROM pr_runtime_decisions WHERE execution_id=$1 ORDER BY revision',
            [result.grant.id],
          )
        ).rows;
        assert(rows.every((row) => row.state === 'ACCEPTED'));
        assert.equal(
          new Set(rows.map((row) => row.revision)).size,
          rows.length,
        );
      });
      // 范围：合法结论在无效目标动作前落库；失败动作不能产生节点命令，不覆盖实际 DOM 定位。
      await suite.test('progress 先落库再拒绝非法动作', async () => {
        const result = await run(1, 'verification', (context, index) =>
          index === 1
            ? {
                type: 'browser.act',
                action: 'click',
                target: 'nonexistent',
                progress: finish(context).progress,
              }
            : finish(context),
        );
        assert.equal(result.report.verdict, 'PASSED');
        assert(
          !result.commands.some(
            (row) =>
              row.command.type === 'browser.act' &&
              row.command.action !== 'navigate',
          ),
        );
        const snapshot = (
          await db.query(
            'SELECT snapshot FROM pr_execution_runtimes WHERE execution_id=$1',
            [result.grant.id],
          )
        ).rows[0].snapshot;
        assert.equal(snapshot.browser.state.criteria[0].verdict, 'PASSED');
        assert(result.seen.length >= 2);
      });
      // 范围：未知点击效果沿用原根因且不重放；回执由节点夹具生成，不证明真实 DOM 故障。
      await suite.test('未知写入保留根因、部分结论并停止清理', async () => {
        const decide = (context) =>
          context.task.stepId === 'verify'
            ? { type: 'browser.act', action: 'click', target: 'element-1' }
            : finish(context);
        const decorate = ({ node }) => {
          node.domUnknownClick = true;
          node.observationTargets = [
            { target: 'element-1', role: 'button', name: '提交' },
          ];
        };
        const legacy = await run(0, 'case', decide, decorate);
        const runtime = await run(1, 'case', decide, decorate);
        assert.equal(
          runtime.report.executionDetails.reasonCode,
          'BROWSER_EFFECT_UNKNOWN',
        );
        assert.equal(runtime.saved.error.code, 'DOM_ENGINE_FAILED');
        assert.deepEqual(
          runtime.report.steps.map((row) => row.status),
          legacy.report.steps.map((row) => row.status),
        );
        assert.equal(runtime.report.steps.at(-1).status, 'SKIPPED');
        assert.equal(
          runtime.commands.filter(
            (row) =>
              row.command.type === 'browser.act' &&
              row.command.action === 'click',
          ).length,
          1,
        );
        const operation = (
          await db.query(
            "SELECT result FROM pr_runtime_operations WHERE execution_id=$1 AND intent->'command'->>'action'='click'",
            [runtime.grant.id],
          )
        ).rows[0];
        assert.equal(operation.result.effect, 'MAY_HAVE_HAPPENED');
      });
      // 范围：非法模型协议的修复反馈与用量计数保持一致；不使用真实模型供应商。
      await suite.test('模型格式错误后保留修复反馈和真实调用数', async () => {
        const decide = (context, index) =>
          index === 1
            ? {
                raw: {
                  choices: [
                    {
                      finish_reason: 'stop',
                      message: { role: 'assistant', content: 'invalid' },
                    },
                  ],
                  usage: { prompt_tokens: 7, completion_tokens: 3 },
                },
              }
            : finish(context);
        const legacy = await run(0, 'verification', decide);
        const runtime = await run(1, 'verification', decide);
        assert.equal(runtime.report.verdict, 'PASSED');
        assert.deepEqual(
          runtime.seen.map((row) => row.feedback),
          legacy.seen.map((row) => row.feedback),
        );
        assert.equal(runtime.report.executionDetails.modelCalls, 2);
        assert.equal(runtime.report.executionDetails.promptTokens, 27);
        assert.equal(runtime.report.executionDetails.completionTokens, 13);
      });
      // 范围：管理员暂停使旧模型回复失效，恢复后重取观察；只验证交接协议，不进行真实人工登录。
      await suite.test('控制代次变化拒绝旧决定，恢复后重新观察', async () => {
        let resumed;
        let resumeFailure;
        const result = await run(
          1,
          'hitl',
          async (context, index, _body, _request, { grant, control }) => {
            if (index === 1) {
              await ok('POST', `/v1/admin/executions/${grant.id}/intervene`, {
                type: 'execution.intervene',
                controlRevision: 0,
                reason: '夹具暂停核对',
              });
              resumed = (async () => {
                const view = await until(
                  () => control.view(grant),
                  (view) => view.controlMode === 'HUMAN',
                );
                await ok('POST', `/v1/admin/executions/${grant.id}/control`, {
                  type: 'execution.control',
                  action: 'resume',
                  controlRevision: view.controlRevision,
                });
              })().catch((error) => {
                resumeFailure = error;
              });
            }
            return complete(context);
          },
        );
        await resumed;
        if (resumeFailure) throw resumeFailure;
        assert.equal(result.report.verdict, 'PASSED');
        assert(result.seen.length >= 2);
        assert.notEqual(
          result.seen[0].page.observationId,
          result.seen[1].page.observationId,
        );
        const rows = (
          await db.query(
            'SELECT state,trace_finish_done FROM pr_runtime_decisions WHERE execution_id=$1 ORDER BY revision',
            [result.grant.id],
          )
        ).rows;
        assert.equal(rows[0].state, 'ABORTED');
        assert.equal(rows[0].trace_finish_done, true);
        assert.equal(rows.at(-1).state, 'ACCEPTED');
      });
      // 范围：服务端驱动不得替离线 worker 续租，GET 也不延长权限；使用模拟节点，不测操作系统进程崩溃。
      await suite.test('worker 未续租时终止服务端等待', async () => {
        const fixture = await enqueue();
        const grant = await until(() => client.claim(), Boolean);
        await client.runtimeStart(grant, runtimeConfig);
        await until(
          () => client.runtimeView(grant, 0, new AbortController().signal),
          (view) => view.decisions.length === 1,
        );
        const initial = (
          await db.query(
            'SELECT lease_expires_at FROM pr_executions WHERE id=$1',
            [grant.id],
          )
        ).rows[0].lease_expires_at;
        await closed(fixture.id);
        const row = (
          await db.query(
            'SELECT lease_expires_at,state FROM pr_executions WHERE id=$1',
            [grant.id],
          )
        ).rows[0];
        assert.equal(row.lease_expires_at.toISOString(), initial.toISOString());
        assert.notEqual(row.state, 'RUNNING');
        assert.equal(
          fixture.commands.filter(
            (row) =>
              row.command.type === 'browser.act' &&
              row.command.action !== 'navigate',
          ).length,
          0,
        );
        await until(
          () =>
            db.query(
              'SELECT state FROM pr_runtime_decisions WHERE execution_id=$1',
              [grant.id],
            ),
          (value) => value.rows.every((row) => row.state === 'ABORTED'),
        );
      });
      // 范围：构造崩溃后遗留记录，调用启动恢复器验证只关闭、不重放；不模拟真实 kill -9 或磁盘故障。
      await suite.test('启动恢复结束遗留执行并保留操作事实', async () => {
        const fixture = await enqueue();
        const grant = await until(() => client.claim(), Boolean);
        await db.query(
          "INSERT INTO pr_execution_runtimes(execution_id,state,config,snapshot) VALUES($1,'ACTIVE',$2,$3)",
          [grant.id, runtimeConfig, { retained: 'fixture' }],
        );
        await db.query(
          "INSERT INTO pr_runtime_operations(command_id,execution_id,input_hash,intent,state) VALUES($1,$2,'fixture','{}','PENDING')",
          [randomUUID(), grant.id],
        );
        const recovery = new Database(url.toString());
        try {
          await recoverLostRuntimes(recovery);
          await recoverLostRuntimes(recovery);
        } finally {
          await recovery.close();
        }
        await closed(fixture.id);
        const runtime = (
          await db.query(
            'SELECT * FROM pr_execution_runtimes WHERE execution_id=$1',
            [grant.id],
          )
        ).rows[0];
        assert.equal(runtime.state, 'LOST');
        assert.equal(runtime.error_code, 'EXECUTION_RUNTIME_LOST');
        assert.deepEqual(runtime.snapshot, { retained: 'fixture' });
        assert.equal(
          (
            await db.query(
              'SELECT state FROM pr_runtime_operations WHERE execution_id=$1',
              [grant.id],
            )
          ).rows[0].state,
          'ABORTED',
        );
        assert.equal(
          fixture.commands.filter(
            (row) =>
              row.command.type === 'browser.act' &&
              row.command.action !== 'navigate',
          ).length,
          0,
        );
        const restart = await api(
          'POST',
          `/v1/executions/${grant.id}/runtime`,
          { type: 'start', config: runtimeConfig },
          grant.leaseToken,
        );
        assert.equal(restart.status, 409);
      });
    } finally {
      await app.close();
      for (const node of nodes) node.close();
      await db.end();
      await rm(root, { recursive: true, force: true });
      await adminDb.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await adminDb.end();
    }
  },
);
