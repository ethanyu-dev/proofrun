import assert from 'node:assert/strict';
import test from 'node:test';
import { compileStepBudget } from '../../contracts/dist/index.js';
import { execute } from '../../apps/agent/dist/execution/runner.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { AgentFault } from '../../apps/agent/dist/http.js';
import { observation } from '../../packages/execution-core/dist/evidence/observation.js';
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

// 范围：等待拒绝后使用新观察且不重复提交；浏览器回执为夹具，真实截止时间另由 Linux 测试覆盖。
test('有界等待未确认后重新观察，已经提交的表单不重放', async () => {
  const client = new FakeControl();
  const original = client.command.bind(client);
  client.command = async (...args) => {
    if (args[2].type !== 'browser.wait') return original(...args);
    client.calls.push({ id: args[1], operation: args[2] });
    return {
      operationStatus: 'FAILED',
      effect: 'NOT_STARTED',
      error: { code: 'CONDITION_NOT_MET' },
    };
  };
  let before;
  const report = await run(grant(), client, (context, turn) => {
    if (turn === 1)
      return {
        type: 'browser.act',
        action: 'fill',
        target: '@e1',
        value: 'Alice',
      };
    if (turn === 2)
      return { type: 'browser.act', action: 'click', target: '@e2' };
    if (turn === 3) {
      before = context.page.observationId;
      return {
        type: 'browser.wait',
        selector: 'body',
        text: '不存在的完成文案',
      };
    }
    assert.notEqual(context.page.observationId, before);
    assert.match(
      context.feedback.map((item) => item.message ?? item.code).join(' '),
      /BROWSER_WAIT_NOT_MET/,
    );
    assert.equal(client.submitted, true);
    return finish(context);
  });
  assert.equal(report.verdict, 'PASSED');
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'click').length,
    1,
  );
});

// 范围：错误预期不能导致无限轮询；只验证 Agent 限额，不代表真实页面超时率。
test('连续未确认的等待在既有恢复上限内停止', async () => {
  const client = new FakeControl();
  const original = client.command.bind(client);
  client.command = async (...args) => {
    if (args[2].type !== 'browser.wait') return original(...args);
    client.calls.push({ id: args[1], operation: args[2] });
    return {
      operationStatus: 'FAILED',
      effect: 'NOT_STARTED',
      error: { code: 'CONDITION_NOT_MET' },
    };
  };
  const report = await run(grant(), client, () => ({
    type: 'browser.wait',
    selector: 'body',
    text: '不存在',
  }));
  assert.equal(report.executionDetails.reasonCode, 'BROWSER_WAIT_NOT_MET');
  assert.equal(
    client.calls.filter((c) => c.operation.type === 'browser.wait').length,
    3,
  );
  assert.notEqual(report.verdict, 'PASSED');
});

// 范围：未知等待回执仍终止，不能借相同错误码放宽副作用约束；不注入真实网络丢包。
test('等待效果未知不能当成条件未满足恢复', async () => {
  const client = new FakeControl();
  const original = client.command.bind(client);
  client.command = async (...args) => {
    if (args[2].type !== 'browser.wait') return original(...args);
    client.calls.push({ id: args[1], operation: args[2] });
    return {
      operationStatus: 'UNKNOWN',
      effect: 'MAY_HAVE_HAPPENED',
      error: { code: 'CONDITION_NOT_MET' },
    };
  };
  const report = await run(grant(), client, () => ({
    type: 'browser.wait',
    selector: 'body',
    text: '不存在',
  }));
  assert.equal(report.executionDetails.reasonCode, 'BROWSER_EFFECT_UNKNOWN');
  assert.equal(
    client.calls.filter((c) => c.operation.type === 'browser.wait').length,
    1,
  );
});

// 范围：前置失败后重新观察并由模型重新决策，不自动重发旧动作；不验证真实页面点击可靠性。
test('点击准备故障后换用新观察，模型可以改选填写动作', async () => {
  const client = new FakeControl();
  preparationFailures(client, 1);
  let firstObservation;
  const report = await run(grant(), client, (context, turn) => {
    if (turn === 1) {
      firstObservation = context.page.observationId;
      return { type: 'browser.act', action: 'click', target: '@e2' };
    }
    if (turn === 2) {
      assert.notEqual(context.page.observationId, firstObservation);
      assert.match(
        context.feedback.map((item) => item.message ?? item.code).join(' '),
        /BROWSER_ACTION_PRECONDITION_FAILED/,
      );
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

// 范围：前置条件未变时不再派发重复点击，恢复建议耗尽后停止当前步骤，后续业务和独立清理继续；不声称故障业务步骤已通过。
test('准备恢复耗尽只阻塞当前步骤，后续步骤与清理仍执行', async () => {
  const client = new FakeControl();
  preparationFailures(client, 100);
  const report = await run(caseGrant(), client, (context) =>
    context.task.stepId === 'step-1'
      ? { type: 'browser.act', action: 'click', target: '@e2' }
      : {
          ...finish(context),
          evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
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
    1,
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
    context.task.stepId === 'step-2'
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
    assert.deepEqual(context.page.documents, documents);
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

// 范围：非法滚动值不派发，下一轮收到具体格式说明后可按方向重试；模型与浏览器均为夹具，不验证真实滚动效果。
test('滚动参数错误返回方向格式，不能通过递增像素数反复猜测', async () => {
  for (const value of [
    'up:400',
    'up:1400',
    'up:2200',
    'up:2600',
    'top',
    undefined,
  ]) {
    const client = new FakeControl();
    const original = client.command.bind(client);
    client.command = async (...args) => {
      const result = await original(...args);
      if (args[2].type === 'browser.observe')
        result.data.viewport = {
          width: 1000,
          height: 800,
          scrollDistance: true,
        };
      return result;
    };
    const report = await run(grant(), client, (context, turn, body) => {
      const act = body.tools.find(
        (tool) => tool.function.name === 'browser_act',
      );
      const scroll = act.function.parameters.allOf.find(
        (rule) => rule.if.properties.action.const === 'scroll',
      ).then;
      assert.deepEqual(scroll.properties.value.enum, [
        'up',
        'down',
        'left',
        'right',
      ]);
      assert(scroll.required.includes('value'));
      // 没有滚动容器时允许页面滚动，但禁止模型附上普通控件 target。
      assert.deepEqual(scroll.not, { required: ['target'] });
      if (turn === 1) return { type: 'browser.act', action: 'scroll', value };
      if (turn === 2) {
        assert.equal(
          client.calls.filter((c) => c.operation.action === 'scroll').length,
          0,
        );
        assert.match(
          context.feedback.map((f) => f.message ?? '').join(' '),
          /scroll.value 只能是 up、down、left、right/,
        );
        return { type: 'browser.act', action: 'scroll', value: 'up' };
      }
      return finish(context);
    });
    assert.equal(report.verdict, 'PASSED', report.summary);
    assert.deepEqual(
      client.calls
        .filter((c) => c.operation.action === 'scroll')
        .map((c) => c.operation.value),
      ['up:600'],
    );
  }
});

// 范围：四个方向、容器限定、节点幅度上限及旧节点格式；只验证执行器派发参数，不证明页面已到达目标位置。
test('滚动方向由模型选择，页面和容器的距离仍由执行器计算', async () => {
  const samples = [
    {
      direction: 'up',
      viewport: { width: 1000, height: 800, scrollDistance: true },
      expected: 'up:600',
    },
    {
      direction: 'down',
      viewport: { width: 1000, height: 4000, scrollDistance: true },
      expected: 'down:1200',
    },
    {
      direction: 'left',
      viewport: { scrollDistance: true },
      container: true,
      expected: 'left:450',
    },
    { direction: 'right', viewport: {}, expected: 'right' },
  ];
  for (const sample of samples) {
    const client = new FakeControl();
    const original = client.command.bind(client);
    client.command = async (...args) => {
      const result = await original(...args);
      if (args[2].type === 'browser.observe') {
        result.data.viewport = sample.viewport;
        if (sample.container)
          result.data.targets.push({
            target: '@list',
            role: 'region',
            name: '可滚动列表',
            operations: ['scroll'],
            scroll: { width: 500, height: 400 },
          });
      }
      return result;
    };
    const report = await run(grant(), client, (context, turn, body) => {
      if (sample.container) {
        const act = body.tools.find(
          (tool) => tool.function.name === 'browser_act',
        );
        const scroll = act.function.parameters.allOf.find(
          (rule) => rule.if.properties.action.const === 'scroll',
        ).then;
        assert.deepEqual(scroll.properties.target.enum, ['@list']);
        assert(!scroll.required.includes('target'));
      }
      if (turn === 1)
        return {
          type: 'browser.act',
          action: 'scroll',
          value: sample.direction,
          ...(sample.container ? { target: '@list' } : {}),
        };
      return finish(context);
    });
    assert.equal(report.verdict, 'PASSED', report.summary);
    const scrolls = client.calls.filter((c) => c.operation.action === 'scroll');
    assert.equal(scrolls.length, 1);
    assert.equal(scrolls[0].operation.value, sample.expected);
    if (sample.container) assert.equal(scrolls[0].operation.target, '@list');
  }
});

// 范围：证明未发送按键的失败先补采再重新决策，最多提交一次原按键；不运行真实页面。
test('定向聚焦失败重新观察，不能直接重放按键', async () => {
  const client = new FakeControl();
  const original = client.command.bind(client);
  client.command = async (...args) => {
    if (args[2].action === 'press') {
      client.calls.push({ id: args[1], operation: args[2] });
      return {
        operationStatus: 'UNKNOWN',
        effect: 'MAY_HAVE_HAPPENED',
        error: { code: 'KEYBOARD_FOCUS_UNCONFIRMED' },
        data: { keyboard: { focusAttempted: true, keyDispatched: false } },
      };
    }
    const reply = await original(...args);
    if (args[2].type === 'browser.observe')
      reply.data.viewport = { targetedPress: true };
    return reply;
  };
  let before;
  const report = await run(grant(), client, (context, turn) => {
    if (turn === 1) {
      before = context.page.observationId;
      return {
        type: 'browser.act',
        action: 'press',
        target: '@e1',
        value: 'Enter',
      };
    }
    assert.notEqual(context.page.observationId, before);
    assert.match(
      context.feedback.map((f) => f.message ?? f.code).join(' '),
      /BROWSER_FOCUS_CHANGED/,
    );
    return finish(context);
  });
  assert.equal(report.verdict, 'PASSED');
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'press').length,
    1,
  );
  const press = client.calls.findIndex((c) => c.operation.action === 'press');
  assert.equal(client.calls[press + 1].operation.type, 'browser.observe');
});

// 范围：观察解码保留 runtime 以及独立附件引用，不代表已验证任何业务标准。
test('运行时探针数据不会在 Agent 观察边界丢失', async () => {
  const client = new FakeControl();
  const reply = await client.command(grant(), 'o', { type: 'browser.observe' });
  reply.data.runtime = {
    version: 1,
    status: 'observed',
    serviceWorker: { registrations: [] },
  };
  reply.data.artifactRefs.push({
    artifactId: 'runtime',
    kind: 'RUNTIME',
    sha256: 'b'.repeat(64),
  });
  assert.deepEqual(observation(reply).runtime, reply.data.runtime);
  assert.equal(observation(reply).artifactRefs.at(-1).kind, 'RUNTIME');
});
