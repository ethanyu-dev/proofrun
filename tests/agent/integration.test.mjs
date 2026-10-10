import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/api/dist/app.js';
import {
  SimulatedNode,
  task,
  until,
  PNG,
  PNG_HASH,
} from '../../apps/api/test/fixture.ts';
import { ControlClient } from '../../apps/agent/dist/client.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { execute } from '../../apps/agent/dist/execution/runner.js';
import { pause } from '../../apps/agent/dist/http.js';
import { config as agentConfig, finish, modelServer } from './fixture.mjs';

/** 使用 API workspace 已固定的 PostgreSQL 驱动，不额外安装测试专用版本。 */
const { default: pg } = await import(
  createRequire(
    new URL('../../apps/api/package.json', import.meta.url),
  ).resolve('pg')
);
const ADMIN = 'proofrun-agent-admin-integration-only';
const WORKER = 'proofrun-agent-worker-integration-only';

// 范围：真实 Agent、模型 HTTP 适配、API 和 PostgreSQL；浏览器动作来自 WebSocket 夹具。
test(
  '执行 Agent 与控制面的报告及撤权闭环',
  { timeout: 60_000 },
  async (suite) => {
    assert.ok(process.env.PROOFRUN_TEST_DATABASE_URL, '需要独立测试数据库');
    const adminDb = new pg.Pool({
      connectionString: process.env.PROOFRUN_TEST_DATABASE_URL,
    });
    const name = `proofrun_agent_${randomUUID().replaceAll('-', '')}`;
    await adminDb.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.PROOFRUN_TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    const root = await mkdtemp(join(tmpdir(), 'proofrun-agent-test-'));
    const holder = createServer();
    await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const port = holder.address().port;
    await new Promise((resolve) => holder.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const app = await buildApp(
      {
        caseProfile: {
          environment: { id: 'v2-fixture', nodePool: 'v2-agent' },
          budget: { timeoutMs: 15000, maxActions: 20 },
          executionMode: 'llm',
          evidenceKinds: ['DOM'],
        },
        databaseUrl: url.toString(),
        adminToken: ADMIN,
        workerToken: WORKER,
        publicUrl: base,
        host: '127.0.0.1',
        port,
        artifactDirectory: join(root, 'artifacts'),
        workerLeaseMs: 1000,
        nodeLeaseMs: 1000,
        tickMs: 25,
      },
      { logger: false },
    );
    const nodes = [];
    const api = async (method, path, body) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          authorization: `Bearer ${ADMIN}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.ok(response.ok, `${method} ${path}: ${response.status}`);
      return response.json();
    };
    /** 补采可以增加证据数量；逐份验证下载、摘要与引用，避免靠固定数量掩盖交付缺失。 */
    const verifyEvidence = async (report) => {
      assert(report.artifacts.length > 0);
      const ids = new Set(report.artifacts.map((artifact) => artifact.id));
      assert.equal(ids.size, report.artifacts.length);
      for (const criterion of report.criteria) {
        if (['PASSED', 'FAILED'].includes(criterion.verdict))
          assert(criterion.evidenceRefs.length > 0);
        assert(criterion.evidenceRefs.every((id) => ids.has(id)));
      }
      for (const artifact of report.artifacts) {
        assert.equal(new URL(artifact.uri).origin, base);
        const response = await fetch(artifact.uri, {
          headers: { authorization: `Bearer ${ADMIN}` },
          signal: AbortSignal.timeout(5000),
        });
        assert.equal(response.status, 200);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(
          createHash('sha256').update(bytes).digest('hex'),
          artifact.sha256,
        );
        if (artifact.kind === 'SCREENSHOT') assert.deepEqual(bytes, PNG);
      }
    };
    await app.listen({ host: '127.0.0.1', port });
    const run = async (
      definition,
      decide,
      { unknown = false, vision = false, thinking, beforeComplete } = {},
    ) => {
      const node = new SimulatedNode(base, definition.environment.nodePool);
      nodes.push(node);
      node.unknownWrite = unknown;
      const uploads = [];
      const original = node.execute.bind(node);
      node.execute = (command) => {
        original(command);
        const result = node.results.get(command.commandId);
        for (const ref of result?.data?.artifactRefs ?? [])
          uploads.push(
            (async () => {
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
            })(),
          );
      };
      await node.pair(ADMIN);
      await until(
        async () => (await api('GET', '/v1/nodes')).nodes,
        (rows) => rows.some((n) => n.id === node.id && n.online),
      );
      await api('POST', '/v1/tasks', definition);
      const server = await modelServer((...args) =>
        decide(...args, { execution, client }),
      );
      const settings = {
        ...agentConfig,
        apiUrl: base,
        workerToken: WORKER,
        modelUrl: server.url,
        vision,
        thinking,
        modelMs: 5000,
      };
      const client = new ControlClient(settings);
      const execution = await until(() => client.claim(), Boolean);
      try {
        assert.equal(execution.task.taskId, definition.taskId);
        const report = await execute(
          settings,
          client,
          new ChatModel(settings),
          execution,
        );
        await beforeComplete?.();
        await client.complete(execution, report);
        const stored = await until(
          () => api('GET', `/v1/tasks/${definition.taskId}`),
          (value) => value.executions.every((e) => e.closure_verified),
        );
        assert.deepEqual(server.errors, []);
        await Promise.all(uploads);
        return {
          report,
          stored,
          node,
          requests: server.requests,
          execution,
          client,
        };
      } finally {
        await server.close();
      }
    };
    try {
      // 范围：真实模型协议夹具到 PostgreSQL 的正文、鉴权、幂等和不可变性；不验证真实模型推理或浏览器页面。
      // 范围：新版 HTTP 输入经真实执行器、步骤持久化和清理任务形成闭环；浏览器与模型均为夹具。
      await suite.test(
        '结构化 case 的逐步执行、部分结论和清理贯通',
        async () => {
          const node = new SimulatedNode(base, 'v2-agent');
          nodes.push(node);
          await node.pair(ADMIN);
          const step = {
            type: 'verification',
            url: 'http://127.0.0.1/fixture',
            exec_order: 2,
            description: '检查夹具结果',
            policy: [],
            expected: ['页面可观察'],
          };
          await api('POST', '/v2/cases', [
            {
              caseId: 'v2-run',
              platform: '夹具',
              entry: step.url,
              steps: [
                { ...step, type: 'setup', exec_order: 1, expected: [] },
                step,
              ],
              cleanup: [
                { url: step.url, exec_order: 1, description: '恢复指定夹具值' },
              ],
            },
          ]);
          const executeNext = async (decide) => {
            const model = await modelServer(decide);
            const settings = {
              ...agentConfig,
              apiUrl: base,
              workerToken: WORKER,
              modelUrl: model.url,
              maxContextChars: 30000,
              commandMs: 3000,
              evidenceMs: 3000,
              maxTurns: 10,
            };
            const client = new ControlClient(settings);
            try {
              const grant = await until(
                () => client.claim(),
                (g) => g !== null,
              );
              const report = await execute(
                settings,
                client,
                new ChatModel(settings),
                grant,
              );
              assert.deepEqual(model.errors, []);
              return { report, grant };
            } finally {
              await model.close();
            }
          };
          const completed = (context) => ({
            ...finish(context),
            evidenceRefs: context.observation.artifactRefs.map(
              (a) => a.artifactId,
            ),
          });
          const main = await executeNext(completed);
          assert.equal(main.report.verdict, 'PASSED');
          assert.deepEqual(
            main.report.steps.map((s) => s.status),
            ['COMPLETED', 'COMPLETED'],
          );
          await until(
            () => api('GET', '/v2/cases/v2-run'),
            (c) => c.cleanup.status === 'QUEUED',
          );
          const cleaned = await executeNext(completed);
          assert.equal(cleaned.grant.task.purpose, 'cleanup');
          assert.equal(cleaned.report.verdict, 'PASSED');
          const result = await api('GET', '/v2/cases/v2-run');
          assert.equal(result.cleanup.result.outcome, 'PASSED');
          await api('POST', '/v2/cases', [
            {
              caseId: 'v2-partial',
              platform: '夹具',
              entry: step.url,
              steps: [step, { ...step, exec_order: 3 }],
              cleanup: [],
            },
          ]);
          const partial = await executeNext((context) =>
            context.executionStep.stepId === 'step-1'
              ? completed(context)
              : { type: 'verification.block', summary: '夹具缺少下一项数据' },
          );
          assert.equal(
            partial.report.executionDisposition,
            'BLOCKED',
            JSON.stringify(partial.report),
          );
          assert.deepEqual(
            partial.report.criteria.map((c) => c.verdict),
            ['PASSED', 'SKIPPED'],
          );
          const persisted = await api('GET', '/v2/cases/v2-partial');
          assert.deepEqual(
            persisted.steps.map((s) => s.status),
            ['COMPLETED', 'BLOCKED'],
          );
          await api('POST', `/v1/nodes/${node.id}/revoke`);
          node.close();
        },
      );

      // 范围：真实 Agent 请求经 HTTP 存档到 PostgreSQL；模型和浏览器是夹具，不证明供应商推理质量。
      await suite.test(
        '思考参数贯通 Agent、存档校验和模型派发，非法扩展仍被拒绝',
        async () => {
          for (const thinking of [undefined, 'disabled', 'enabled']) {
            const { report, execution, requests } = await run(
              task(`agent-thinking-${thinking ?? 'default'}`),
              async (context, _turn, body, _request, { execution, client }) => {
                const path = `/v1/admin/executions/${execution.id}/model-calls`;
                const list = await api('GET', path);
                assert.equal(list.calls.length, 1);
                const call = await api('GET', `${path}/${list.calls[0].id}`);
                // 模型服务收到请求时必须已存在同一份待回执存档。
                assert.equal(call.status, 'PENDING');
                assert.deepEqual(JSON.parse(call.request), body);
                assert.deepEqual(
                  body.thinking,
                  thinking ? { type: thinking } : undefined,
                );
                assert.equal(
                  call.requestSha256,
                  createHash('sha256')
                    .update(JSON.stringify(body))
                    .digest('hex'),
                );
                if (thinking === 'disabled') {
                  const invalidRequests = [
                    ...[
                      null,
                      false,
                      'disabled',
                      [],
                      {},
                      { type: 'default' },
                      { type: ['disabled'] },
                      { type: 'disabled', api_key: 'fixture-secret' },
                    ].map((value) => ({ ...body, thinking: value })),
                    { ...body, authorization: 'fixture-secret' },
                    { ...body, url: 'https://unexpected.invalid' },
                  ];
                  for (const request of invalidRequests) {
                    const id = randomUUID();
                    await assert.rejects(
                      client.recordModelCall(execution, id, {
                        phase: 'start',
                        record: {
                          ...call,
                          id,
                          callIndex: 200,
                          request: JSON.stringify(request),
                        },
                      }),
                      (error) =>
                        error.code === 'INVALID_MODEL_CALL' &&
                        error.status === 400,
                    );
                  }
                  assert.equal((await api('GET', path)).calls.length, 1);
                }
                return finish(context);
              },
              { thinking },
            );
            assert.equal(report.verdict, 'PASSED');
            assert.equal(requests.length, 1);
            const path = `/v1/admin/executions/${execution.id}/model-calls`;
            const list = await api('GET', path);
            const call = await api('GET', `${path}/${list.calls[0].id}`);
            assert.equal(call.status, 'RECEIVED');
            assert.deepEqual(JSON.parse(call.request), requests[0]);
          }
        },
      );

      await suite.test('按实际请求保存决策上下文并隔离执行权限', async () => {
        const { execution, client, requests } = await run(
          task('agent-context-record'),
          finish,
        );
        const path = `/v1/admin/executions/${execution.id}/model-calls`;
        const list = await api('GET', path);
        assert.equal(list.calls.length, requests.length);
        assert.ok(!('request' in list.calls[0]));
        assert.ok(!('response' in list.calls[0]));
        const call = await api('GET', `${path}/${list.calls[0].id}`);
        assert.deepEqual(JSON.parse(call.request), requests[0]);
        assert.equal(
          call.requestSha256,
          createHash('sha256')
            .update(JSON.stringify(requests[0]))
            .digest('hex'),
        );
        assert.equal(call.status, 'RECEIVED');
        assert.equal(call.promptTokens, 20);
        const start = {
          phase: 'start',
          record: {
            ...call,
            status: 'PENDING',
            finishedAt: null,
            response: null,
            error: null,
            promptTokens: null,
            completionTokens: null,
            elapsedMs: null,
          },
        };
        await client.recordModelCall(execution, call.id, start);
        await assert.rejects(
          client.recordModelCall(execution, call.id, {
            ...start,
            record: { ...start.record, request: '{"model":"changed"}' },
          }),
          (error) => error.code === 'MODEL_CALL_CONFLICT',
        );
        const receipt = {
          phase: 'finish',
          result: Object.fromEntries(
            [
              'finishedAt',
              'status',
              'response',
              'error',
              'promptTokens',
              'completionTokens',
              'elapsedMs',
            ].map((key) => [key, call[key]]),
          ),
        };
        await client.recordModelCall(execution, call.id, receipt);
        await assert.rejects(
          client.recordModelCall(execution, call.id, {
            ...receipt,
            result: { ...receipt.result, response: '{}' },
          }),
          (error) => error.code === 'MODEL_CALL_CONFLICT',
        );
        const wrongToken = await fetch(
          `${base}/v1/executions/${execution.id}/model-calls/${call.id}`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${WORKER}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(start),
          },
        );
        assert.equal(wrongToken.status, 401);
        const deniedRead = await fetch(base + path, {
          headers: { authorization: `Bearer ${execution.leaseToken}` },
        });
        assert.equal(deniedRead.status, 401);
        const lateId = randomUUID();
        await assert.rejects(
          client.recordModelCall(execution, lateId, {
            phase: 'start',
            record: { ...start.record, id: lateId, callIndex: 2 },
          }),
          (error) => error.code === 'EXECUTION_EXPIRED',
        );
      });
      // 范围：领取协议、DOM 归档、模型报告和幂等完成；不证明实际页面业务状态。
      await suite.test('任务领取到标准报告及会话回收', async () => {
        const { report, stored, client, execution } = await run(
          task('agent-success'),
          finish,
        );
        assert.equal(stored.state, 'COMPLETED');
        assert.equal(report.verdict, 'PASSED');
        assert.equal(stored.report.executionDetails.model, agentConfig.model);
        // 导航外壳可能补采观察；验证可用证据与归属，不把采样次数固定为一次。
        assert(stored.report.artifacts.length >= 1);
        assert(stored.report.artifacts.every((a) => a.kind === 'DOM'));
        assert(
          stored.report.criteria[0].evidenceRefs.every((id) =>
            stored.report.artifacts.some((a) => a.id === id),
          ),
        );
        await verifyEvidence(stored.report);
        await assert.rejects(
          client.complete(execution, { ...report, summary: '篡改终态' }),
          (error) => error.code === 'REPORT_CONFLICT',
        );
      });
      // 范围：图片上传、执行范围下载、摘要核实和模型图片输入；像素为夹具，不是浏览器截图。
      await suite.test('截图到模型输入与报告引用', async () => {
        const { report, execution, requests } = await run(
          task('agent-vision', true),
          (context, _turn, body) => {
            assert.equal(
              body.messages[1].content[1].image_url.url,
              `data:image/png;base64,${PNG.toString('base64')}`,
            );
            return finish(context);
          },
          { vision: true },
        );
        assert.equal(report.verdict, 'PASSED');
        // 截图与 DOM 可随外壳补采多次产生；要求两种媒介及实际验收引用均存在。
        await verifyEvidence(report);
        assert(report.artifacts.some((a) => a.kind === 'DOM'));
        assert(report.artifacts.some((a) => a.kind === 'SCREENSHOT'));
        assert.deepEqual(
          new Set(
            report.criteria[0].evidenceRefs.map(
              (id) => report.artifacts.find((a) => a.id === id).kind,
            ),
          ),
          new Set(['DOM', 'SCREENSHOT']),
        );
        const path = `/v1/admin/executions/${execution.id}/model-calls`;
        const list = await api('GET', path);
        const call = await api('GET', `${path}/${list.calls[0].id}`);
        assert.equal(call.imagesOmitted, 1);
        assert.ok(!call.request.includes(PNG.toString('base64')));
        assert.equal(
          call.requestSha256,
          createHash('sha256')
            .update(JSON.stringify(requests[0]))
            .digest('hex'),
        );
        assert.ok(
          JSON.parse(
            call.request,
          ).messages[1].content[1].image_url.evidenceRefs.some(
            (ref) => ref.kind === 'SCREENSHOT',
          ),
        );
      });
      // 范围：能力不足的 BLOCKED 语义与报告幂等；不验证真实模型视觉能力探测。
      await suite.test('阻塞报告不会伪造业务失败', async () => {
        const { report, stored } = await run(task('agent-block', true), () => {
          throw new Error('不应调用模型');
        });
        assert.equal(stored.state, 'COMPLETED');
        assert.equal(report.executionDisposition, 'BLOCKED');
        assert.equal(report.verdict, null);
      });
      // 范围：控制面先终止未知写入后仍可挂接故障报告；不模拟真实引擎重试机制。
      await suite.test('未知写入终止后挂接 ERROR 报告', async () => {
        const { report, stored, node } = await run(
          task('agent-unknown'),
          () => {
            throw new Error('不应调用模型');
          },
          { unknown: true },
        );
        assert.equal(stored.state, 'ERROR');
        assert.equal(
          report.executionDetails.reasonCode,
          'BROWSER_EFFECT_UNKNOWN',
        );
        assert.equal(
          [...node.results.values()].filter(
            (r) => r.effect === 'MAY_HAVE_HAPPENED',
          ).length,
          1,
        );
      });
      // 范围：真实取消与续租拒绝中断在途模型；迟到完成报告不能覆盖 CANCELLED。
      await suite.test('模型调用期间取消，报告保持控制面终态', async () => {
        const definition = task('agent-cancel');
        const { stored } = await run(definition, async (context) => {
          await api('POST', `/v1/tasks/${definition.taskId}/cancel`);
          await pause(500);
          return finish(context);
        });
        assert.equal(stored.state, 'CANCELLED');
        assert.equal(stored.report.lifecycle, 'CANCELLED');
        assert.equal(stored.report.executionDisposition, 'ERROR');
        assert.equal(stored.report.verdict, null);
      });
      // 范围：任务总预算包括模型时间，超时终态不能被报告提前或迟到改写；不模拟跨主机时钟漂移。
      await suite.test('任务截止后仍可保存可追溯故障报告', async () => {
        const definition = task('agent-timeout');
        definition.budget.timeoutMs = 750;
        const { stored } = await run(
          definition,
          async (context) => {
            await pause(1100);
            return finish(context);
          },
          {
            // 明确验证迟到报告：Agent 定时器可能提前不足 1ms 唤醒，不能靠其返回时机代替控制面截止。
            beforeComplete: () =>
              until(
                () => api('GET', `/v1/tasks/${definition.taskId}`),
                (value) => value.state === 'TIMED_OUT',
              ),
          },
        );
        assert.equal(stored.state, 'TIMED_OUT');
        assert.equal(stored.report.lifecycle, 'TIMED_OUT');
        assert.equal(stored.report.verdict, null);
      });

      // 范围：真实 Agent/HTTP/租约跨过初始截止时间后恢复；人工和浏览器为协议夹具，不代表业务登录有效。
      await suite.test('模型请求人工、管理员操作后恢复并报告', async () => {
        const definition = task('human-agent');
        definition.environment.allowIntervention = true;
        definition.budget.timeoutMs = 3000;
        let operator;
        const outcome = await run(definition, (context, turn) => {
          if (turn === 1) {
            operator = (async () => {
              const detail = await until(
                () => api('GET', `/v1/tasks/${definition.taskId}`),
                (d) => d.executions[0]?.control_mode === 'HUMAN',
              );
              const execution = detail.executions[0];
              await pause(
                Math.max(0, Date.parse(detail.deadline_at) - Date.now()) + 150,
              );
              assert.equal(
                (await api('GET', `/v1/tasks/${definition.taskId}`)).state,
                'RUNNING',
              );
              const basePath = `/v1/admin/executions/${execution.id}`;
              const commandId = randomUUID();
              await api('POST', `${basePath}/commands`, {
                type: 'execution.command',
                commandId,
                controlRevision: execution.control_revision,
                timeoutMs: 5000,
                command: { type: 'browser.act', action: 'press', value: 'Tab' },
              });
              await until(
                () => api('GET', `${basePath}/activity`),
                (a) =>
                  a.commands.some(
                    (c) => c.id === commandId && c.status === 'SUCCEEDED',
                  ),
              );
              await api('POST', `${basePath}/control`, {
                type: 'execution.control',
                action: 'resume',
                controlRevision: execution.control_revision,
              });
            })();
            return {
              type: 'verification.intervene',
              reason: '人工处理页面前提',
            };
          }
          assert.ok(context.budgetRemaining.timeMs > 19 * 60000);
          assert.equal(
            context.budgetRemaining.actions,
            definition.budget.maxActions - 1,
          );
          return finish(context);
        });
        await operator;
        assert.equal(outcome.report.verdict, 'PASSED');
        // 只统计 Agent 的首次导航；人工操作不出现在 Agent 动作消耗中。
        assert.equal(outcome.report.executionDetails.actions, 1);
      });
      // 范围：真实 HTTP/WS 控制面在节点仍连接时能完成关闭；不覆盖进程强杀或 VM 断电。
      await suite.test(
        '活动节点长连接不阻止控制面退出',
        { timeout: 5000 },
        async () => {
          assert(nodes.some((node) => node.socket?.readyState === 1));
          await app.close();
          await until(
            () => nodes.every((node) => node.socket?.readyState !== 1),
            Boolean,
            2000,
          );
        },
      );
    } finally {
      nodes.forEach((node) => node.close());
      await app.close();
      await adminDb.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await adminDb.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
