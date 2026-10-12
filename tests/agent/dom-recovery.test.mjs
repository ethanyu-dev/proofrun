import assert from 'node:assert/strict';
import test from 'node:test';
import { compileStepBudget } from '../../contracts/dist/index.js';
import { execute } from '../../apps/agent/dist/execution/runner.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { AgentFault } from '../../apps/agent/dist/http.js';
import { observation } from '../../apps/agent/dist/evidence/observation.js';
import { config, grant, FakeControl, finish, modelServer } from './fixture.mjs';

/** 独立业务步骤与清理使用真实预算编译器，浏览器和模型决策仍为脚本夹具。 */
function caseGrant() {
  const execution = grant();
  execution.task.steps = [1, 2, 3].map((index) => ({
    stepId: `step-${index}`,
    type: index === 3 ? 'setup' : 'verification',
    url: execution.task.target.url,
    exec_order: index,
    description: `检查步骤 ${index}`,
    policy: [],
    expected: index === 3 ? [] : ['出现预期文案'],
  }));
  execution.task.cleanupStepIds = ['step-3'];
  execution.task.acceptanceCriteria = execution.task.steps.flatMap((s) =>
    s.expected.map((expectedResult) => ({
      id: `${s.stepId}-expected-1`,
      stepId: s.stepId,
      description: s.description,
      expectedResult,
      evidenceKinds: ['DOM'],
    })),
  );
  execution.task.stepBudget = compileStepBudget(execution.task);
  return execution;
}

/** 每个测试使用独立模型 HTTP 服务，关闭资源后再返回报告。 */
async function run(execution, client, decide) {
  const server = await modelServer(decide);
  const settings = { ...config, modelUrl: server.url };
  try {
    const report = await execute(
      settings,
      client,
      new ChatModel(settings),
      execution,
    );
    assert.deepEqual(server.errors, []);
    return report;
  } finally {
    await server.close();
  }
}

/** 仅注入尚未执行的点击故障，不使用原夹具的成功副作用模拟失败。 */
function preparationFailures(client, failures) {
  const original = client.command.bind(client);
  client.command = async (...args) => {
    if (args[2].action === 'click' && failures-- > 0) {
      client.calls.push({ id: args[1], operation: args[2] });
      return {
        operationStatus: 'FAILED',
        effect: 'NOT_STARTED',
        error: { code: 'DOM_ACTION_PRECONDITION_FAILED' },
      };
    }
    return original(...args);
  };
}

// 范围：前置失败后重新观察并由模型重新决策，不自动重发旧动作；不验证真实页面点击可靠性。
test('点击准备故障后换用新观察，模型可以改选填写动作', async () => {
  const client = new FakeControl();
  preparationFailures(client, 1);
  let firstObservation;
  const report = await run(grant(), client, (context, turn) => {
    if (turn === 1) {
      firstObservation = context.observation.observationId;
      return { type: 'browser.act', action: 'click', target: '@e2' };
    }
    if (turn === 2) {
      assert.notEqual(context.observation.observationId, firstObservation);
      assert.match(context.feedback, /BROWSER_ACTION_PRECONDITION_FAILED/);
      assert.equal(client.submitted, false);
      return {
        type: 'browser.act',
        action: 'fill',
        target: '@e1',
        value: 'Alice',
      };
    }
    return finish(context);
  });
  assert.equal(report.verdict, 'PASSED');
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'click').length,
    1,
  );
  assert.equal(client.value, 'Alice');
});

// 范围：连续失败在第三次停止当前步骤，后续业务和独立清理继续；不声称故障业务步骤已通过。
test('准备恢复耗尽只阻塞当前步骤，后续步骤与清理仍执行', async () => {
  const client = new FakeControl();
  preparationFailures(client, 100);
  const report = await run(caseGrant(), client, (context) =>
    context.executionStep.stepId === 'step-1'
      ? { type: 'browser.act', action: 'click', target: '@e2' }
      : {
          ...finish(context),
          evidenceRefs: context.observation.artifactRefs.map(
            (a) => a.artifactId,
          ),
        },
  );
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['BLOCKED', 'COMPLETED', 'COMPLETED'],
  );
  assert.equal(
    report.steps[0].reasonCode,
    'BROWSER_ACTION_PRECONDITION_FAILED',
  );
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'click').length,
    3,
  );
  assert.deepEqual(
    report.criteria.map((c) => c.verdict),
    ['SKIPPED', 'PASSED'],
  );
});

// 范围：已派发点击导致终态撤权时，保存步骤的 409 不覆盖根因和先前验收；未知写入不继续后续业务或清理。
test('未知点击后的步骤保存拒绝保留原始故障', async () => {
  const client = new FakeControl();
  const command = client.command.bind(client);
  const recordSteps = client.recordSteps.bind(client);
  let terminated = false;
  client.command = async (...args) => {
    const result = await command(...args);
    if (args[2].action === 'click') {
      terminated = true;
      result.operationStatus = 'UNKNOWN';
      result.effect = 'MAY_HAVE_HAPPENED';
      result.error = { code: 'DOM_ENGINE_FAILED' };
    }
    return result;
  };
  client.recordSteps = async (...args) => {
    if (terminated)
      throw new AgentFault(
        'EXECUTION_EXPIRED',
        '服务拒绝请求（HTTP 409）',
        409,
      );
    return recordSteps(...args);
  };
  const report = await run(caseGrant(), client, (context) =>
    context.executionStep.stepId === 'step-2'
      ? { type: 'browser.act', action: 'click', target: '@e2' }
      : finish(context),
  );
  assert.equal(report.executionDetails.reasonCode, 'BROWSER_EFFECT_UNKNOWN');
  assert.match(report.summary, /DOM_ENGINE_FAILED/);
  assert.doesNotMatch(JSON.stringify(report), /HTTP 409|EXECUTION_EXPIRED/);
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['COMPLETED', 'ERROR', 'SKIPPED'],
  );
  assert.deepEqual(
    report.criteria.map((c) => c.verdict),
    ['PASSED', 'SKIPPED'],
  );
  assert.match(report.steps[2].summary, /DOM_ENGINE_FAILED/);
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'click').length,
    1,
  );
});

// 范围：原生文档声明通过解析、上下文和真实模型 HTTP 传递；声明未知不被伪造成中文，不覆盖真实模型判断质量。
test('语言声明逐 frame 传给模型，兼容旧节点并拒绝错误类型', async () => {
  const client = new FakeControl();
  const command = client.command.bind(client);
  const documents = [
    { frameId: 'main', url: 'http://intranet.test/form', lang: 'zh-CN' },
    { frameId: 'child', url: 'http://intranet.test/child', lang: 'en' },
    { frameId: 'missing', url: 'about:blank', lang: '' },
    { frameId: 'unknown', url: 'about:blank', lang: null },
  ];
  client.command = async (...args) => {
    const result = await command(...args);
    if (args[2].type === 'browser.observe') result.data.documents = documents;
    return result;
  };
  const report = await run(grant(), client, (context, _turn, body) => {
    assert.deepEqual(context.observation.documents, documents);
    assert.match(body.messages[0].content, /不为确认同一事实反复 navigate/);
    return finish(context);
  });
  assert.equal(report.verdict, 'PASSED');
  const result = await command(grant(), 'read-fixture', {
    type: 'browser.observe',
  });
  assert.equal(observation(result).documents, undefined);
  for (const malformed of [
    null,
    {},
    [{ frameId: 'main', url: '/', lang: 42 }],
  ]) {
    result.data.documents = malformed;
    assert.throws(
      () => observation(result),
      (e) => e.code === 'INVALID_OBSERVATION',
    );
  }
});
