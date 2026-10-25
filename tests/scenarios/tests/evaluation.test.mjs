import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { assist } from '../harness/human.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CASES, definition, bindings, suite } from '../cases/catalog.mjs';
import { validateVerificationCaseV2 } from '../../../contracts/dist/index.js';
import { startFixture, fixtureRequest } from '../fixture/server.mjs';
import { facts, evaluate } from '../oracles/evaluate.mjs';
import { compareRuns, summarize, usage } from '../harness/summary.mjs';
import {
  ensureSubmitted,
  callAllowance,
  planSamples,
} from '../harness/runner.mjs';
import { canonical, save, read, lock } from '../harness/storage.mjs';
import { compileCase } from '../../../apps/api/src/modules/cases/structured.ts';

// 范围：真实回环 WebSocket 的拒绝码传递及连接关闭；服务为夹具，不验证真实浏览器或人工登录。
test('人工交接保留稳定拒绝码，不导出服务端原始消息', async () => {
  const require = createRequire(
    new URL('../../../apps/api/package.json', import.meta.url),
  );
  const { WebSocketServer } = require('ws');
  const { server, http } = await directFixture(WebSocketServer);
  server.on('connection', (socket) =>
    socket.once('message', () =>
      socket.send(
        JSON.stringify({
          type: 'error',
          code: 'HITL_STREAM',
          message: '不应导出的服务端诊断',
        }),
      ),
    ),
  );
  try {
    await assert.rejects(
      assist(
        { origin: `http://127.0.0.1:${server.address().port}` },
        { id: 'fixture', path: '/fixture/token' },
        'sample',
        async () => assert.fail('认证拒绝后不能读取或输入验证码'),
      ),
      { message: 'HITL_REJECTED_HITL_STREAM' },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => http.close(resolve));
  }
});

// 范围：两类交接的 WebSocket 确认报文；已登录事实为夹具，不验证浏览器输入或账号身份。
test('人工交接仅在服务端提供条件身份时回传条件键', async (t) => {
  const require = createRequire(
    new URL('../../../apps/api/package.json', import.meta.url),
  );
  const { WebSocketServer } = require('ws');
  for (const conditionKeys of [undefined, ['condition-1']]) {
    await t.test(conditionKeys ? '结构化条件' : '普通待办', async () => {
      const { server, http } = await directFixture(WebSocketServer);
      let completion;
      server.on('connection', (socket) =>
        socket.on('message', (bytes) => {
          const message = JSON.parse(bytes.toString());
          if (message.type === 'authenticate')
            socket.send(
              JSON.stringify({
                type: 'state',
                mode: 'HUMAN',
                items: ['确认登录'],
                targetUrl: 'http://127.0.0.1/runs/sample',
                ...(conditionKeys ? { conditionKeys } : {}),
              }),
            );
          else if (message.type === 'complete') {
            completion = message;
            socket.send(JSON.stringify({ type: 'completed' }));
          }
        }),
      );
      try {
        await assist(
          { origin: `http://127.0.0.1:${server.address().port}` },
          { id: 'fixture', path: '/fixture/token' },
          'sample',
          async () => ({ loggedIn: true }),
        );
        assert.deepEqual(completion, {
          type: 'complete',
          confirmedItems: [0],
          ...(conditionKeys ? { confirmedConditionKeys: conditionKeys } : {}),
        });
      } finally {
        await new Promise((resolve) => server.close(resolve));
        await new Promise((resolve) => http.close(resolve));
      }
    });
  }
});

/** 最小事实来自预制事件，验证判定算法；不将人工构造的 DOM 当真实浏览器证据。 */
function input(id = 'E01', verdict = 'PASSED') {
  const scenario = CASES.find((c) => c.id === id);
  const value = definition(scenario, 'sample', 'http://127.0.0.1:8000');
  const frozen = compileCase(value, {
    environment: {
      id: 'eval',
      nodePool: 'eval',
      allowIntervention: true,
      reuseAuth: false,
    },
    executionMode: 'llm',
    budget: { maxActions: 10 },
    evidenceKinds: ['DOM'],
  });
  const falseSuccess = id === 'E08';
  const text = falseSuccess ? '记录不存在' : '已保存名称 Atlas';
  const artifacts = [
    {
      id: 'dom',
      kind: 'DOM',
      sha256: 'fixture-hash',
      verified: true,
      text: JSON.stringify({ text }),
    },
  ];
  const detail = {
    id: frozen.taskId,
    definition: frozen,
    state: 'COMPLETED',
    executions: [{ closure_verified: true }],
    report: {
      taskId: frozen.taskId,
      verdict,
      artifacts,
      criteria: bindings(scenario, frozen).map((b) => ({
        criterionId: b.criterionId,
        verdict,
        evidenceRefs: ['dom'],
      })),
      steps: [],
    },
  };
  const state = {
    events: [
      { sequence: 1, type: 'submit', group: 'main', value: 'Atlas' },
      {
        sequence: 2,
        type: 'query',
        group: 'main',
        record: falseSuccess ? null : { value: 'Atlas' },
        text,
      },
    ],
  };
  return { scenario, detail, state, artifacts };
}

// 范围：全部定义满足现有 v2 协议且映射到实际编译身份；不执行模型或浏览器。
test('十二个场景使用现有契约，预算和验收身份由冻结定义决定', () => {
  assert.equal(CASES.length, 12);
  for (const scenario of CASES) {
    const value = definition(scenario, 'sample', 'http://127.0.0.1:8000');
    assert.ok(
      validateVerificationCaseV2(value),
      JSON.stringify(validateVerificationCaseV2.errors),
    );
    const { detail } = input(scenario.id);
    assert.equal(
      bindings(scenario, detail.definition).length,
      scenario.checks.length,
    );
    assert.ok(callAllowance(value, 'llm') > 0);
    assert.equal(callAllowance(value, 'jev'), callAllowance(value, 'llm') * 2);
  }
  assert.deepEqual(
    suite('smoke').map((c) => c.id),
    ['E01', 'E08', 'E12'],
  );
});

// 范围：正确识别已知缺陷也是测评通过；不证明真实模型能发现此缺陷。
test('业务 FAILED 与测评通过独立', () => {
  assert.equal(evaluate(input()).passed, true);
  const result = evaluate(input('E08', 'FAILED'));
  assert.equal(result.passed, true);
  assert.equal(result.businessSatisfied, false);
  assert.equal(result.criteria[0].classification, 'CORRECT');
});

// 范围：正反结论和信息缺失分别分类；不能把未知事实视为产品失败。
test('错误通过、错误失败与未观察分别保留', () => {
  assert.equal(evaluate(input('E08')).criteria[0].classification, 'FALSE_PASS');
  assert.equal(
    evaluate(input('E01', 'FAILED')).criteria[0].classification,
    'FALSE_FAIL',
  );
  const value = input();
  value.state.events = [];
  assert.equal(
    evaluate(value).criteria[0].classification,
    'UNSUPPORTED_CONCLUSION',
  );
  value.detail.report.criteria[0].verdict = 'SKIPPED';
  assert.equal(evaluate(value).criteria[0].classification, 'UNOBSERVED');
});

// 范围：证据正文、摘要回执、报告归属及唯一记录；不替代截图视觉语义验收。
test('有文件或正确摘要不能替代内容及归属', () => {
  const value = input();
  value.artifacts[0].text = JSON.stringify({
    text: '尚未操作',
    targets: [{ name: '已保存名称 Atlas' }],
  });
  assert.equal(
    evaluate(value).criteria[0].classification,
    'EVIDENCE_INSUFFICIENT',
  );
  value.artifacts[0].text = JSON.stringify({ text: '已保存名称 Atlas' });
  value.artifacts[0].verified = false;
  assert.equal(evaluate(value).passed, false);
  value.artifacts[0].verified = true;
  value.detail.report.taskId = 'other';
  assert.ok(evaluate(value).issues.includes('REPORT_MISSING_OR_WRONG_TASK'));
  value.detail.report.criteria.push(value.detail.report.criteria[0]);
  assert.equal(
    evaluate(value).criteria[0].classification,
    'DUPLICATE_CRITERION',
  );
});

// 范围：禁止重复写入和空会话数组的 vacuous truth；不模拟实际 systemd 进程回收。
test('重复提交和缺少关闭事实拒绝通过', () => {
  const value = input();
  value.state.events.push({ sequence: 3, type: 'submit', group: 'main' });
  value.detail.executions = [];
  const result = evaluate(value);
  assert.ok(result.issues.includes('DUPLICATE_SUBMISSION'));
  assert.equal(result.closureVerified, false);
});

// 范围：清理后保留业务历史，清理失败独立计分；不覆盖真实会话清理动作。
test('删除后的查询不抹掉已完成业务事实', () => {
  const value = input('E12');
  value.state.events.push(
    { sequence: 3, type: 'delete', group: 'main' },
    {
      sequence: 4,
      type: 'query',
      group: 'main',
      record: null,
      text: '记录不存在',
    },
  );
  value.detail.report.steps.push({ stepId: 'cleanup', status: 'COMPLETED' });
  assert.equal(facts(value.scenario, value.state)[0].truth, 'SATISFIED');
  assert.equal(evaluate(value).passed, true);
  value.detail.report.steps[0].status = 'ERROR';
  assert.ok(evaluate(value).issues.includes('CLEANUP_INCOMPLETE'));
});

// 范围：HTTP 业务写入、私有管理隔离、事件持久化与不同样本隔离；没有真实 Chrome 或模型。
test('夹具真实 HTTP 记录独立事实且公开端口没有管理接口', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pr-eval-'));
  const socketPath = join(directory, 'admin.sock');
  const fixture = await startFixture({ directory, socketPath });
  const base = `http://127.0.0.1:${fixture.port}`;
  try {
    const one = await fixtureRequest(socketPath, 'one', {
      scenarioId: 'E01',
      version: 1,
    });
    await fixtureRequest(socketPath, 'two', { scenarioId: 'E08', version: 1 });
    const action = async (id, action, extra = {}) =>
      (
        await fetch(`${base}/runs/${id}/action`, {
          method: 'POST',
          body: JSON.stringify({ action, ...extra }),
        })
      ).json();
    assert.equal((await fetch(base + '/metrics')).status, 404);
    assert.equal((await fetch(base + '/one')).status, 404);
    assert.ok(
      !(await (await fetch(base + '/runs/one')).text()).includes(one.code),
    );
    await action('one', 'save', { value: 'Atlas' });
    await action('two', 'save', { value: 'Atlas' });
    assert.equal((await action('one', 'query')).text, '已保存名称 Atlas');
    assert.equal((await action('two', 'query')).text, '记录不存在');
    await action('one', 'delete');
    const saved = await read(join(directory, 'one.json'));
    assert.equal(saved.events.filter((e) => e.type === 'commit').length, 1);
    assert.equal(
      (await fixtureRequest(socketPath, 'two')).events.filter(
        (e) => e.type === 'commit',
      ).length,
      0,
    );
    const again = await fixtureRequest(socketPath, 'one', {
      scenarioId: 'E01',
      version: 1,
    });
    assert.deepEqual(again.events, saved.events);
    await assert.rejects(
      fixtureRequest(socketPath, 'one', { scenarioId: 'E08', version: 1 }),
    );
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// 范围：恢复时先查原身份，并在派发前持久化意图；只模拟 HTTP 端口，不证明数据库原子性。
test('提交回执丢失后沿用原身份，已有请求不重交', async () => {
  const sample = {
    id: 'one',
    submission: { requestId: 'one', cases: [{ caseId: 'one' }] },
  };
  let saved = false;
  let posted = 0;
  let stored = null;
  const control = {
    findRequest: async () => stored,
    json: async (_path, body) => {
      assert.ok(saved);
      assert.equal(body.requestId, 'one');
      posted++;
      stored = { cases: [{ caseId: 'one', arms: [{ taskId: 'task' }] }] };
      throw Error('模拟丢回执');
    },
  };
  await assert.rejects(
    ensureSubmitted(control, sample, async () => {
      saved = true;
    }),
  );
  assert.equal(await ensureSubmitted(control, sample, async () => {}), 'task');
  assert.equal(posted, 1);
});

// 范围：不把重复请求成员或双跑混入独立样本；不测试实际 API 双跑行为。
test('恢复拒绝请求身份冲突或意外双跑', async () => {
  await assert.rejects(
    ensureSubmitted(
      {
        findRequest: async () => ({
          cases: [{ caseId: 'x', arms: [{ taskId: 'a' }, { taskId: 'b' }] }],
        }),
      },
      { id: 'x' },
      async () => {},
    ),
  );
});

// 范围：清单可重放顺序、原子写入与排他锁；不证明断电后的文件系统持久化。
test('运行清单原子保存，固定种子保持配对顺序', async () => {
  const left = planSamples('left', CASES, 3, 'seed');
  const right = planSamples('right', CASES, 3, 'seed');
  assert.equal(left.length, 36);
  assert.deepEqual(
    left.map((s) => s.key),
    right.map((s) => s.key),
  );
  const directory = await mkdtemp(join(tmpdir(), 'pr-eval-'));
  try {
    const release = await lock(directory);
    await assert.rejects(lock(directory));
    await save(join(directory, 'value.json'), { b: 1, a: 2 });
    assert.equal(
      canonical(await read(join(directory, 'value.json'))),
      '{"a":2,"b":1}',
    );
    await release();
    const next = await lock(directory);
    await next();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// 范围：不完整用量和缺样本显式展示；数值由夹具提供，不代表真实供应商计费。
test('统计不把缺失用量填零，不隐藏未运行和失败样本', () => {
  assert.equal(
    usage([{ promptTokens: 1, completionTokens: null }]).complete,
    false,
  );
  assert.equal(usage([]).promptTokens, null);
  const summary = summarize(
    { runId: 'run', samples: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    [{ id: 'a', submissionIntentAt: 'now', error: 'FAILED' }, { id: 'b' }],
  );
  assert.equal(summary.started, 1);
  assert.deepEqual(summary.notRun, ['b', 'c']);
  assert.equal(summary.incomplete.length, 1);
});

// 范围：离线比较拒绝版本或样本缺口，预算差异显式报告；不估计统计显著性。
test('版本比较对齐全集并保留预算差异', () => {
  const manifest = {
    formatVersion: 1,
    scenarioVersion: 1,
    oracleVersion: 1,
    scenarioDigest: 'abc',
    seed: 'x',
    suite: 'core',
    repeat: 1,
    samples: [{ id: 'a', key: 'E01:1' }],
  };
  const a = {
    manifest,
    samples: [
      {
        id: 'a',
        key: 'E01:1',
        result: { passed: true },
        budget: 1,
        elapsedMs: 10,
      },
    ],
  };
  const b = structuredClone(a);
  b.samples[0].result.passed = false;
  b.samples[0].budget = 2;
  assert.equal(compareRuns(a, b).pairs[0].status, 'REGRESSED');
  assert.equal(compareRuns(a, b).pairs[0].budgetsMatch, false);
  b.manifest.scenarioDigest = 'different';
  assert.throws(() => compareRuns(a, b));
  b.manifest.scenarioDigest = 'abc';
  b.samples = [];
  assert.throws(() => compareRuns(a, b));
});

/** 回环 bootstrap 与独立直连路径夹具；只验证客户端协议，不配置真实节点或 TLS。 */
async function directFixture(WebSocketServer) {
  const http = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/hitl/bootstrap') {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        direct: {
          id: 'fixture',
          token: 'fixture-direct-token',
          controlUrl: `ws://127.0.0.1:${http.address().port}/hitl/control`,
        },
      }),
    );
  });
  const server = new WebSocketServer({ server: http, path: '/hitl/control' });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  return { server, http };
}
