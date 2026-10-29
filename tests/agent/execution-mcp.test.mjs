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
import {
  executionMcpTools,
  validateExternalExecutionResult,
} from '../../contracts/dist/index.js';
const require = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
);
const { default: pg } = await import(require.resolve('pg'));
const { Client } = await import(
  require.resolve('@modelcontextprotocol/sdk/client/index.js')
);
const { StreamableHTTPClientTransport } = await import(
  require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')
);
/** 仅用于本地回归；两种分离 channel 的令牌属于同一 principal。 */
const ADMIN = 'execution-mcp-admin',
  WORKER = 'execution-mcp-worker';
const TOKENS = {
  full: 'execution-mcp-full',
  browser: 'execution-mcp-browser',
  verification: 'execution-mcp-verification',
  read: 'execution-mcp-read',
  other: 'execution-mcp-other',
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
/** 冻结 setup、verification、cleanup 原始定义；预期值由夹具提供，不代表真实站点验收。 */
function example() {
  return {
    caseId: randomUUID(),
    platform: 'MCP 执行夹具',
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
        description: '检查标题',
        policy: [],
        expected: ['标题存在'],
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
/** 范围：真实 MCP SDK/HTTP/PostgreSQL/共享执行器；节点和业务判断是夹具，不覆盖真实 Codex 模型、Chromium 或账号注入。 */
test(
  '两套 MCP 的操作发现、权限和直接验证闭环',
  { timeout: 120000 },
  async (suite) => {
    assert.ok(process.env.PROOFRUN_TEST_DATABASE_URL);
    const admin = new pg.Pool({
      connectionString: process.env.PROOFRUN_TEST_DATABASE_URL,
    });
    const name = `proofrun_mcp_execution_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.PROOFRUN_TEST_DATABASE_URL);
    url.pathname = `/${name}`;
    const db = new pg.Pool({ connectionString: url.toString() });
    const root = await mkdtemp(join(tmpdir(), 'proofrun-mcp-execution-'));
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
      externalIdleMs: 30000,
      executionRuntimeVersion: 1,
      publicCredentials: Object.entries(TOKENS).map(([kind, token]) => ({
        principalId: kind === 'other' ? 'other' : 'caller',
        tokenSha256: createHash('sha256').update(token).digest('hex'),
        channels: ['browser', 'verification'].includes(kind)
          ? [kind]
          : ['browser', 'verification'],
        scopes:
          kind === 'read'
            ? ['runs:read']
            : kind === 'browser'
              ? SCOPES.filter((s) => s !== 'verification:control')
              : kind === 'verification'
                ? SCOPES.filter((s) => s !== 'browser:control')
                : SCOPES,
      })),
      caseProfile: {
        environment: {
          id: 'fixture',
          nodePool: 'mcp-execution',
          allowIntervention: true,
        },
        budget: { timeoutMs: 60000, maxActions: 20 },
        executionMode: 'llm',
        evidenceKinds: ['DOM', 'NETWORK'],
      },
    };
    let app = await buildApp(config, { logger: false });
    let address = await app.listen({ host: '127.0.0.1', port: 0 });
    let node;
    const clients = [];
    const uploads = [];
    const connect = async (channel, token = TOKENS.full) => {
      const client = new Client({
        name: 'codex-protocol-fixture',
        version: '1.0',
      });
      clients.push(client);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`/mcp/${channel}`, address), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      await client.listTools();
      return client;
    };
    const call = async (client, name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return result.structuredContent;
    };
    const denied = async (client, name, args, code) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.equal(result.structuredContent.code, code, JSON.stringify(result));
    };
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
    let browser, verification, bOnly, vOnly, read, other;
    const context = async (id, formal = false) =>
      call(
        formal ? verification : browser,
        formal ? 'verification_get_context' : 'browser_session_get',
        { controllerId: id },
      );
    const ready = (id, formal = false) =>
      until(
        () => context(id, formal),
        (r) => ['ACT', 'READ_REPORT'].includes(r.data.nextAction),
      );
    const envelope = (data, decision) => ({
      controllerId: data.controllerId,
      operationId: randomUUID(),
      expectedRevision: data.revision,
      observationId: data.context.page.observationId,
      ...(data.context.task.stepId ? { stepId: data.context.task.stepId } : {}),
      decision,
    });
    const settled = (operationId, formal = false) =>
      until(
        () =>
          call(
            formal ? verification : browser,
            formal ? 'verification_operation_get' : 'browser_operation_get',
            { operationId },
          ),
        (r) => r.data.status !== 'RUNNING',
      );
    const open = async () => {
      const input = {
        operationId: randomUUID(),
        taskKey: randomUUID(),
        url: 'https://example.test',
        objective: '观察页面并交付结果',
      };
      const r = await call(browser, 'browser_session_open', input);
      return { id: r.data.controllerId, runId: r.data.runId, input };
    };
    const submit = async (definition = example()) => {
      const input = {
        requestId: randomUUID(),
        cases: [definition],
        executor: { kind: 'external' },
      };
      assert.equal(
        (await call(vOnly, 'verification_validate_cases', input)).data.valid,
        true,
      );
      const submitted = await call(vOnly, 'verification_submit_cases', input);
      const runId = submitted.data.runs[0].runId;
      const bound = await call(vOnly, 'verification_bind_run', {
        runId,
        operationId: randomUUID(),
      });
      return { id: bound.data.controllerId, runId };
    };
    try {
      browser = await connect('browser');
      verification = await connect('verification');
      bOnly = await connect('browser', TOKENS.browser);
      vOnly = await connect('verification', TOKENS.verification);
      read = await connect('browser', TOKENS.read);
      other = await connect('verification', TOKENS.other);
      // 范围：真实 tools/list、SDK 输出校验、调用授权和通道隔离；不把目录可见性当作运行授权。
      await suite.test(
        '工具发现自包含，隐藏工具仍强制鉴权，两个目录不可混用',
        async () => {
          const bt = (await browser.listTools()).tools,
            vt = (await verification.listTools()).tools;
          assert.equal(bt.length, 17);
          assert.equal(vt.length, 16);
          // 范围：两套真实 MCP 目录交付计时和证据边界，文案不会替代服务端校验。
          assert.match(
            bt.find((t) => t.name === 'browser_session_get').description,
            /decisionDeadlineAt/,
          );
          assert.match(
            vt.find((t) => t.name === 'verification_get_context').description,
            /SETTLEMENT_REQUIRED/,
          );
          assert.match(
            bt.find((t) => t.name === 'browser_network_list').description,
            /capture.coverage/,
          );
          for (const tool of executionMcpTools) {
            const actual = [...bt, ...vt].find((t) => t.name === tool.name);
            assert.ok(actual);
            assert.deepEqual(actual.inputSchema, tool.inputSchema);
            assert.equal(actual.description, tool.description);
            assert.ok(!JSON.stringify(actual).includes('$ref'));
            assert.equal(actual.annotations.idempotentHint, true);
            assert.equal(
              actual.annotations.readOnlyHint,
              tool.name.endsWith('_get') ||
                tool.name === 'verification_get_context',
            );
          }
          assert.ok(
            !(await read.listTools()).tools.some((t) =>
              [
                'browser_act',
                'browser_session_open',
                'browser_observe',
              ].includes(t.name),
            ),
          );
          await denied(read, 'browser_act', {}, 'SCOPE_FORBIDDEN');
          await denied(
            browser,
            'verification_bind_run',
            { runId: 'x', operationId: randomUUID() },
            'TOOL_NOT_FOUND',
          );
          await denied(
            browser,
            'browser_observe',
            {
              controllerId: randomUUID(),
              operationId: randomUUID(),
              expectedRevision: 1,
              observationId: 'x',
              decision: { type: 'browser.observe' },
              report: {},
            },
            'INVALID_INPUT',
          );
          await denied(
            browser,
            'browser_act',
            {
              controllerId: randomUUID(),
              operationId: randomUUID(),
              expectedRevision: 1,
              observationId: 'x',
              decision: {
                type: 'verification.finish',
                summary: '骗过分支',
                progress: {},
              },
            },
            'INVALID_INPUT',
          );
          for (const [channel, token] of [
            ['browser', ADMIN],
            ['verification', WORKER],
            ['verification', TOKENS.browser],
          ])
            await assert.rejects(connect(channel, token));
          const guide = await verification.readResource({
            uri: 'proofrun://guides/tasks',
          });
          assert.ok(guide.contents[0].text.includes('finish_step'));
        },
      );
      node = new SimulatedNode(address, 'mcp-execution', 4);
      node.fullProfile = true;
      node.networkEvidence = true;
      const original = node.execute.bind(node);
      node.execute = (command) => {
        original(command);
        for (const ref of node.results.get(command.commandId)?.data
          ?.artifactRefs ?? []) {
          if (ref.kind !== 'SCREENSHOT') continue;
          const upload = (async () => {
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
              (s) => s === 200,
            );
            node.send({
              type: 'artifact.available',
              messageId: `artifact:${ref.artifactId}`,
              artifactId: ref.artifactId,
              sha256: PNG_HASH,
            });
          })();
          uploads.push(upload);
          void upload.catch(() => {});
        }
      };
      await node.pair(ADMIN);
      await until(
        () => http('GET', '/v1/nodes', undefined, ADMIN),
        (r) => r.body.nodes.some((n) => n.id === node.id && n.online),
      );
      // 范围：仅 MCP 完成正式验证，双 token 同 principal 共享绑定；证据、动作效果及判断均为夹具。
      await suite.test(
        'Codex 协议客户端通过两套 MCP 完成准备、操作、记录、清理和报告',
        async () => {
          const run = await submit();
          let { data } = await ready(run.id, true);
          assert.equal(data.nextAction, 'ACT');
          await denied(
            other,
            'verification_get_context',
            { controllerId: run.id },
            'RESOURCE_NOT_FOUND',
          );
          await denied(
            browser,
            'browser_session_close',
            { controllerId: run.id, operationId: randomUUID() },
            'RUN_KIND_CONFLICT',
          );
          await denied(
            browser,
            'browser_session_finish',
            envelope(data, {
              type: 'verification.finish',
              summary: '不允许通用收尾',
              progress: {},
            }),
            'RUN_KIND_CONFLICT',
          );
          const attached = envelope(data, {
            type: 'browser.observe',
            progress: {
              requirements: [
                {
                  id: data.context.state.requirements[0].id,
                  status: 'complete',
                  summary: '夹具进度',
                  evidenceRefs: data.context.page.artifactRefs.map(
                    (ref) => ref.artifactId,
                  ),
                },
              ],
            },
          });
          await denied(bOnly, 'browser_observe', attached, 'SCOPE_FORBIDDEN');
          await call(vOnly, 'verification_touch_controller', {
            controllerId: run.id,
            operationId: randomUUID(),
          });
          const observe = envelope(data, { type: 'browser.observe' });
          await call(bOnly, 'browser_observe', observe);
          assert.equal(
            (await settled(observe.operationId, true)).data.status,
            'SUCCEEDED',
          );
          assert.deepEqual(
            await call(browser, 'browser_operation_get', {
              operationId: observe.operationId,
            }),
            await call(verification, 'verification_operation_get', {
              operationId: observe.operationId,
            }),
          );
          const { controllerId, ...body } = observe;
          const replay = await http(
            'POST',
            `/v3/controllers/${controllerId}/observations`,
            body,
          );
          assert.equal(replay.status, 202);
          assert.equal(replay.body.data.status, 'SUCCEEDED');
          const ids = (
            await db.query(
              'SELECT command_ids FROM pr_external_operations WHERE id=$1',
              [observe.operationId],
            )
          ).rows[0].command_ids;
          assert.equal(ids.length, 1);
          assert.equal(node.calls.get(ids[0]), 1);
          await denied(
            browser,
            'browser_observe',
            { ...observe, operationId: randomUUID() },
            'REVISION_CONFLICT',
          );
          data = (await ready(run.id, true)).data;
          const image = data.context.page.artifactRefs.find(
            (ref) => ref.kind === 'SCREENSHOT',
          );
          assert.ok(image);
          const imageResult = await browser.callTool({
            name: 'browser_evidence_read',
            arguments: {
              runId: run.runId,
              evidenceId: image.artifactId,
              representation: 'content',
            },
          });
          assert.ok(!imageResult.isError);
          assert.equal(imageResult.content[1].type, 'image');
          assert.equal(imageResult.content[1].data, PNG.toString('base64'));
          assert.ok(!imageResult.structuredContent.data.imageBase64);
          const premature = envelope(data, {
            type: 'verification.finish',
            summary: '尚未准备',
            progress: {},
          });
          await call(vOnly, 'verification_finish_step', premature);
          assert.equal(
            (await settled(premature.operationId, true)).data.status,
            'FAILED',
          );
          const phases = [];
          let acted = false,
            recorded = false,
            report;
          for (let i = 0; i < 25; i++) {
            data = (await ready(run.id, true)).data;
            if (data.nextAction === 'READ_REPORT') {
              report = data.report;
              break;
            }
            phases.push(data.context.state.phase);
            if (data.context.state.phase === 'CHECKING') {
              await denied(
                browser,
                'browser_act',
                envelope(data, {
                  type: 'browser.act',
                  action: 'navigate',
                  target: 'https://example.test/not-now',
                }),
                'ACTION_NOT_ALLOWED',
              );
            }
            if (data.context.state.phase === 'VERIFYING' && !acted) {
              acted = true;
              const action = envelope(data, {
                type: 'browser.act',
                action: 'navigate',
                target: 'https://example.test/check',
              });
              await call(bOnly, 'browser_act', action);
              assert.equal(
                (await settled(action.operationId)).data.status,
                'SUCCEEDED',
              );
              continue;
            }
            const decision = finish(data.context);
            decision.evidenceRefs = data.context.page.artifactRefs.map(
              (ref) => ref.artifactId,
            );
            if (data.context.state.phase === 'CLEANUP')
              decision.progress.requirements =
                data.context.state.requirements.map((item) => ({
                  id: item.id,
                  status: 'complete',
                  summary: '夹具清理完成',
                  evidenceRefs: decision.evidenceRefs,
                }));
            if (data.context.state.phase === 'VERIFYING' && !recorded) {
              recorded = true;
              const record = envelope(data, {
                type: 'verification.record',
                summary: '部分验收',
                progress: decision.progress,
              });
              await call(vOnly, 'verification_record', record);
              assert.equal(
                (await settled(record.operationId, true)).data.progressApplied,
                true,
              );
              continue;
            }
            const payload = envelope(data, decision);
            await call(vOnly, 'verification_finish_step', payload);
            const receipt = await settled(payload.operationId, true);
            assert.equal(
              receipt.data.status,
              'SUCCEEDED',
              JSON.stringify(receipt),
            );
          }
          assert.ok(report);
          assert.equal(report.verdict, 'PASSED');
          assert.equal(report.executor.judgmentSource, 'external_agent');
          assert.equal(report.executor.modelCalls, null);
          for (const phase of ['PREPARING', 'CHECKING', 'VERIFYING', 'CLEANUP'])
            assert.ok(phases.includes(phase));
          assert.ok(acted && recorded);
          await until(
            () => context(run.id, true),
            (r) => r.data.closureVerified,
          );
          assert.equal(
            (
              await call(verification, 'verification_get_run', {
                runId: run.runId,
                view: 'full',
              })
            ).data.executor.kind,
            'external',
          );
          assert.equal(
            (await db.query('SELECT count(*)::int AS n FROM pr_model_calls'))
              .rows[0].n,
            0,
          );
          await denied(
            verification,
            'verification_bind_run',
            { runId: run.runId, operationId: randomUUID() },
            'EXECUTION_ENDED',
          );
        },
      );
      // 范围：通用任务、网络快照、原生证据和工具类型围栏；网络夹具不代表真实请求内容。
      await suite.test(
        '通用浏览器会话读取网络并完成，不能借验证工具写成 Case',
        async () => {
          const run = await open();
          assert.equal(
            (await call(browser, 'browser_session_open', run.input)).data
              .controllerId,
            run.id,
          );
          let { data } = await ready(run.id);
          await denied(
            verification,
            'verification_bind_run',
            { runId: run.runId, operationId: randomUUID() },
            'RUN_KIND_CONFLICT',
          );
          await denied(
            verification,
            'verification_get_context',
            { controllerId: run.id },
            'RUN_KIND_CONFLICT',
          );
          await call(browser, 'browser_session_touch', {
            controllerId: run.id,
            operationId: randomUUID(),
          });
          assert.ok(data.context.page.network.requests.length);
          const list = envelope(data, {
            type: 'network.requests',
            observationId: data.context.page.network.observationId,
            offset: 0,
          });
          await call(browser, 'browser_network_list', list);
          assert.equal(
            (await settled(list.operationId)).data.status,
            'SUCCEEDED',
          );
          data = (await ready(run.id)).data;
          const detail = envelope(data, {
            type: 'network.request_detail',
            observationId: data.context.page.network.observationId,
            requestId: data.context.page.network.requests[0].id,
          });
          await call(browser, 'browser_network_detail', detail);
          assert.equal(
            (await settled(detail.operationId)).data.status,
            'SUCCEEDED',
          );
          data = (await ready(run.id)).data;
          assert.ok(data.context.page.network.detail);
          // 范围：真实控制面恢复同快照，不增加节点观察；节点页面仍为夹具。
          assert.equal(data.context.page.view, 'network');
          assert(!data.allowedActions.includes('browser.act'));
          const networkObservation = data.context.page.observationId;
          const restore = envelope(data, {
            type: 'context.read',
            observationId: networkObservation,
            section: 'page',
          });
          await call(browser, 'browser_context_read', restore);
          assert.equal(
            (await settled(restore.operationId)).data.status,
            'SUCCEEDED',
          );
          data = (await ready(run.id)).data;
          assert.equal(data.context.page.view, 'page');
          assert.equal(data.context.page.observationId, networkObservation);
          assert.ok(data.context.page.network.detail);
          assert(data.allowedActions.includes('browser.act'));
          const decision = {
            type: 'verification.finish',
            summary: '夹具读取网络完成',
            progress: {
              requirements: data.context.state.requirements.map((item) => ({
                id: item.id,
                status: 'complete',
                summary: '完成',
                evidenceRefs: data.context.page.artifactRefs.map(
                  (ref) => ref.artifactId,
                ),
              })),
            },
          };
          const payload = envelope(data, decision);
          await call(browser, 'browser_session_finish', payload);
          assert.equal(
            (await settled(payload.operationId)).data.status,
            'SUCCEEDED',
          );
          const final = await until(
            () => context(run.id),
            (r) =>
              r.data.nextAction === 'READ_REPORT' && r.data.closureVerified,
          );
          assert.equal(final.data.report.verdict, null);
          assert.equal(final.data.report.browserResult.outcome, 'COMPLETED');
          assert.ok(validateExternalExecutionResult(final));
        },
      );
      // 范围：受阻和人工请求复用共享规则，取消通过既有任务工具；不验证真实人工输入或身份确认。
      await suite.test(
        '验证受阻保留业务语义，人工请求撤销旧观察且可用任务回执查询取消',
        async () => {
          const simple = () => {
            const value = example();
            value.steps = value.steps.filter(
              (step) => step.type === 'verification',
            );
            value.cleanup = [];
            return value;
          };
          const blocked = await submit(simple());
          let { data } = await ready(blocked.id, true);
          const payload = envelope(data, {
            type: 'verification.block',
            summary: '夹具缺少结果',
            reasonCode: 'OTHER',
          });
          await call(verification, 'verification_block_step', payload);
          await settled(payload.operationId, true);
          const end = await until(
            () => context(blocked.id, true),
            (r) => r.data.nextAction === 'READ_REPORT',
          );
          assert.equal(end.data.report.executionDisposition, 'BLOCKED');
          assert.notEqual(end.data.report.verdict, 'FAILED');
          const human = await submit(simple());
          data = (await ready(human.id, true)).data;
          const request = envelope(data, {
            type: 'verification.intervene',
            reason: '夹具请求人工确认',
            reasonCode: 'OTHER',
            items: ['确认当前页面'],
          });
          await call(
            verification,
            'verification_request_intervention',
            request,
          );
          await until(
            () => context(human.id, true),
            (r) => r.data.nextAction === 'HUMAN_REQUIRED',
          );
          await denied(
            browser,
            'browser_observe',
            envelope(data, { type: 'browser.observe' }),
            'CONTROL_CHANGED',
          );
          const cancel = { runId: human.runId, operationId: randomUUID() };
          const receipt = await call(
            verification,
            'verification_cancel_run',
            cancel,
          );
          assert.deepEqual(
            await call(verification, 'verification_operation_get', {
              operationId: cancel.operationId,
            }),
            receipt,
          );
          assert.deepEqual(
            await call(browser, 'browser_operation_get', {
              operationId: cancel.operationId,
            }),
            receipt,
          );
          await settled(request.operationId, true);
          await until(
            () => context(human.id, true),
            (r) => r.data.state !== 'ACTIVE',
          );
        },
      );
      // 范围：在途排他、未知效果和幂等取消；模拟丢失回执，不证明真实页面副作用。
      await suite.test('MCP 在途排他、UNKNOWN 重试及关闭不复活', async () => {
        const run = await open();
        let { data } = await ready(run.id);
        node.unknownWrite = true;
        try {
          const payload = envelope(data, {
            type: 'browser.act',
            action: 'navigate',
            target: 'https://example.test/unknown',
          });
          await call(browser, 'browser_act', payload);
          assert.equal(
            (await settled(payload.operationId)).data.status,
            'UNKNOWN',
          );
          assert.equal(
            (await call(browser, 'browser_act', payload)).data.status,
            'UNKNOWN',
          );
        } finally {
          node.unknownWrite = false;
        }
        await until(
          () => context(run.id),
          (r) => r.data.state !== 'ACTIVE',
        );
        const waiting = await open();
        data = (await ready(waiting.id)).data;
        const wait = envelope(data, {
          type: 'browser.wait',
          selector: 'body',
          text: 'never',
        });
        await call(browser, 'browser_wait', wait);
        await denied(
          browser,
          'browser_observe',
          envelope(data, { type: 'browser.observe' }),
          'OPERATION_IN_FLIGHT',
        );
        const close = { controllerId: waiting.id, operationId: randomUUID() };
        await call(browser, 'browser_session_close', close);
        await call(browser, 'browser_session_close', close);
        assert.equal(
          (await call(browser, 'browser_session_open', waiting.input)).data
            .controllerId,
          waiting.id,
        );
        await denied(
          browser,
          'browser_session_touch',
          { controllerId: waiting.id, operationId: randomUUID() },
          'EXECUTION_ENDED',
        );
      });
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await app.close();
      node?.close();
      await Promise.all(uploads);
      await db.end();
      await rm(root, { recursive: true, force: true });
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);
