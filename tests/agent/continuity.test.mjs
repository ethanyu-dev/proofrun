import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileProfilePlan,
  compileStepBudget,
} from '../../contracts/dist/index.js';
import { execute } from '../../apps/agent/dist/execution/runner.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { OperationJournal } from '../../apps/agent/dist/execution/operation-journal.js';
import { config, grant, FakeControl, finish, modelServer } from './fixture.mjs';

/** 构造已规范化的连续步骤；测试不连接业务网站或真实身份服务。 */
function caseGrant(urls) {
  const execution = grant();
  execution.task.steps = urls.map((url, index) => ({
    stepId: `step-${index + 1}`,
    type: 'verification',
    url,
    exec_order: index + 1,
    description: '检查当前页面文案',
    policy: [],
    expected: ['出现预期文案'],
  }));
  execution.task.acceptanceCriteria = execution.task.steps.map((step) => ({
    id: `${step.stepId}-expected-1`,
    stepId: step.stepId,
    description: step.description,
    expectedResult: step.expected[0],
    evidenceKinds: ['DOM'],
  }));
  execution.task.stepBudget = compileStepBudget(execution.task);
  return execution;
}

/** 页面状态夹具：导航会清除临时团队选择，用于识别不必要的重新加载。 */
class PageControl extends FakeControl {
  /** 当前文档与正文只由模拟导航或人工操作改变。 */
  url = 'about:blank';
  pageText = '初始页面';
  /** 控制代次模拟真实交接，不能由模型自行签发。 */
  mode = 'AUTO';
  revision = 0;
  /** 记录交接边界，断言后续没有导航覆盖人工准备的页面。 */
  handoffs = [];
  requestedItems = [];

  /** 每次读取都返回当前控制代次，覆盖人工先于导航完成的时序。 */
  async view(execution) {
    return {
      ...(await super.view(execution)),
      controlMode: this.mode,
      controlRevision: this.revision,
    };
  }

  /** 动作回执沿用会话夹具，额外维护可被导航破坏的页面状态。 */
  async command(execution, id, operation, ...rest) {
    const result = await super.command(execution, id, operation, ...rest);
    if (operation.action === 'navigate') {
      this.url = operation.target;
      this.pageText = '重新加载后的个人空间';
    }
    if (operation.type === 'browser.observe') result.data.url = this.url;
    return result;
  }

  /** 只记录本次实际请求确认的事项，避免所有人工条件被隐式认可。 */
  async intervene(_execution, revision, _reason, _signal, items) {
    assert.equal(revision, this.revision);
    this.requestedItems.push(items);
    this.mode = 'REQUESTED';
    this.revision++;
  }

  /** 模拟人工完成并把同一页面交还 Agent，不启动新会话。 */
  async acknowledge() {
    this.url = 'http://intranet.test/zh/referral';
    this.pageText = '测试团队 · 简体中文 · 人工准备好的页面';
    this.mode = 'AUTO';
    this.revision++;
    this.handoffs.push(this.calls.length);
  }
}

/** 脚本模型只提交当前观察证据，不能据此推断真实模型遵从率。 */
function scripted(decide = finish) {
  return {
    async decide(input) {
      return {
        decision: await decide(JSON.parse(input.text)),
        promptTokens: 0,
        completionTokens: 0,
      };
    },
  };
}

/** 模拟身份准备页与业务分组页分离；认证代次变化遵循控制面协议，不连接真实浏览器。 */
class PreparedProfileControl extends PageControl {
  /** 认证版本独立于人工控制权版本，首次自动准备也会推进。 */
  authRevision = 0;
  /** 每个分组首次访问从空白页开始，不能借用身份准备页的地址。 */
  pages = new Map();
  /** 交还时只确认实际请求的事项。 */
  confirmation;

  /** 同时暴露两种代次，避免把自动准备误当成人工交还。 */
  async view(execution) {
    return {
      ...(await super.view(execution)),
      authRevision: this.authRevision,
      humanConfirmation: this.confirmation,
    };
  }

  /** 身份准备只更新未分组页面，分组导航必须实际派发才改变本组地址。 */
  async command(execution, id, operation, ...rest) {
    if (operation.tabScope)
      this.url = this.pages.get(operation.tabScope) ?? 'about:blank';
    const result = await super.command(execution, id, operation, ...rest);
    if (operation.type === 'browser.identity.prepare') {
      assert.equal(operation.tabScope, undefined);
      this.authRevision++;
      this.url = operation.url;
      result.data = {
        status: 'LOADED',
        source: 'profile',
        reasonCode: 'NODE_TEMPLATE_LOADED',
      };
    }
    if (operation.tabScope) this.pages.set(operation.tabScope, this.url);
    return result;
  }

  /** 在交出控制权的时刻检查目标页，后续模型断言不能掩盖空白页交接。 */
  async intervene(...args) {
    assert.equal(
      this.url,
      args[0].task.target.url,
      '交接前必须已导航到本组入口',
    );
    await super.intervene(...args);
  }

  /** 模拟人工改变地址与身份后交还，供后续观察确认没有多余导航。 */
  async acknowledge() {
    await super.acknowledge();
    this.authRevision++;
    this.pages.set('group-1', this.url);
    this.confirmation = {
      revision: this.revision,
      authRevision: this.authRevision,
      items: this.requestedItems.at(-1),
    };
  }
}

// 范围：自动身份准备推进认证代次后仍打开独立分组页，人工交还不覆盖当前页面；不验收真实登录或节点标签页实现。
for (const selection of ['human', 'selected']) {
  test(`身份准备后保留分组首次导航（${selection}）`, async () => {
    const execution = caseGrant([
      'http://intranet.test/referral',
      'http://intranet.test/referral',
    ]);
    execution.task.target.url = execution.task.steps[0].url;
    execution.task.steps[0].type = 'setup';
    execution.task.steps[0].expected = [];
    execution.task.acceptanceCriteria.shift();
    execution.task.profilePlan = compileProfilePlan(execution.task.steps);
    execution.task.stepBudget = compileStepBudget(execution.task);
    execution.task.environment.allowIntervention = true;
    execution.task.executionPlan = {
      version: 1,
      environment: {
        mode: 'configured',
        source: 'default',
        basis: [],
        resolverVersion: 1,
      },
      evidenceKinds: ['DOM'],
    };
    execution.task.sessionPlan = {
      version: 1,
      mode: 'identity',
      library: true,
      selection,
      selectionReason: '需要人工准备测试账号',
      preparationMs: 120000,
      requirements: [],
      candidates: [
        {
          id: 'fixture',
          label: '测试账号',
          accountKey: 'fixture',
          origins: ['http://intranet.test'],
          checks: [],
          maxConcurrent: 1,
        },
      ],
    };
    const client = new PreparedProfileControl();
    const report = await execute(
      config,
      client,
      {
        async decide(input) {
          const context = JSON.parse(input.text);
          assert.equal(
            context.page.url,
            selection === 'human'
              ? 'http://intranet.test/zh/referral'
              : execution.task.target.url,
          );
          const { workflow, ...decision } = finish(context);
          return { decision, workflow, promptTokens: 0, completionTokens: 0 };
        },
      },
      execution,
    );
    assert.equal(report.verdict, 'PASSED', JSON.stringify(report));
    assert.equal(client.requestedItems.length, selection === 'human' ? 1 : 0);
    assert.deepEqual(
      client.calls
        .filter((c) => c.operation.action === 'navigate')
        .map((c) => c.operation),
      [
        {
          type: 'browser.act',
          action: 'navigate',
          target: execution.task.target.url,
          tabScope: 'group-1',
        },
      ],
    );
    if (selection === 'human')
      assert(
        client.calls
          .slice(client.handoffs[0])
          .every((c) => c.operation.type === 'browser.observe'),
      );
  });
}

// 范围：关键填写回执不会被观察/滚动挤掉，不保留输入值且超限标记省略；不验证真实字段值或业务提示。
test('关键动作记忆独立于近期窗口且不保留输入值', () => {
  const memory = new OperationJournal();
  memory.record({
    commandId: 'fill',
    operation: 'browser.act',
    action: 'fill',
    targetName: '邀请码',
    value: 'private-fixture-value',
    operationStatus: 'SUCCEEDED',
    effect: 'COMPLETED',
  });
  for (let i = 0; i < 40; i++) {
    memory.record({
      commandId: `observe-${i}`,
      operation: 'browser.observe',
      operationStatus: 'SUCCEEDED',
      effect: 'COMPLETED',
    });
    memory.record({
      commandId: `scroll-${i}`,
      operation: 'browser.act',
      action: 'scroll',
      value: 'down',
      operationStatus: 'SUCCEEDED',
      effect: 'COMPLETED',
    });
  }
  assert.equal(memory.critical().items[0].commandId, 'fill');
  assert.equal(memory.critical().items.length, 1);
  assert(!JSON.stringify(memory.critical()).includes('private-fixture-value'));
  for (let i = 0; i < 30; i++)
    memory.record({
      commandId: `click-${i}`,
      operation: 'browser.act',
      action: 'click',
      operationStatus: 'FAILED',
      effect: 'NOT_STARTED',
    });
  assert.equal(memory.critical().items.length, 24);
  assert.equal(memory.critical().omitted, 7);
  assert(
    memory.critical().items.every((item) => item.operationStatus === 'FAILED'),
  );
});

// 范围：执行器传递关键动作并在下一步骤清空；多次滚动模拟新的正文，不代表真实站点验收。
test('填写后跨多轮阅读仍保留动作事实，下一步骤不沿用', async () => {
  const g = caseGrant(Array(2).fill('http://intranet.test/form'));
  g.task.budget.maxActions = 20;
  g.task.stepBudget.steps[0].maxActions = 16;
  g.task.stepBudget.steps[0].maxModelCalls = 30;
  const client = new FakeControl();
  const command = client.command.bind(client);
  client.command = async (...args) => {
    const result = await command(...args);
    if (args[2].type === 'browser.observe')
      result.data.text += ` 阅读区域 ${client.calls.length}`;
    return result;
  };
  let turns = 0;
  const report = await execute(
    config,
    client,
    scripted((context) => {
      if (context.task.stepId === 'step-2') {
        assert.equal(
          context.history.commands.some((item) => item.action === 'fill'),
          false,
        );
        return finish(context);
      }
      turns++;
      if (turns === 1)
        return {
          type: 'browser.act',
          action: 'fill',
          target: '@e1',
          value: 'invalid-fixture',
        };
      if (turns <= 6)
        return { type: 'browser.act', action: 'scroll', value: 'down' };
      assert(
        context.history.commands.some(
          (operation) =>
            operation.action === 'fill' &&
            operation.operationStatus === 'SUCCEEDED',
        ),
      );
      return finish(context);
    }),
    g,
  );
  assert.equal(report.executionDisposition, 'EXECUTED', report.summary);
  assert.equal(turns, 7);
});

// 范围：真实模型 HTTP 正文携带人工确认，交接与同入口步骤保留页面；不验证真实 Cookie 或角色。
test('人工完成后保留团队与语言，后续步骤收到确认事实但仍独立验收', async () => {
  const execution = caseGrant(Array(2).fill('http://intranet.test/referral'));
  execution.task.environment.allowIntervention = true;
  execution.task.sessionPlan = {
    version: 1,
    mode: 'manual',
    candidates: [],
    requirements: [
      { id: 'role', description: '非所有者且未绑定 GitHub', method: 'manual' },
    ],
    preparationMs: 120000,
  };
  const client = new PageControl();
  const observations = [];
  const server = await modelServer((context, turn, body) => {
    assert.equal(context.page.url, 'http://intranet.test/zh/referral');
    assert.equal(context.page.text, client.pageText);
    assert.match(context.page.text, /人工准备好的页面/);
    assert.equal(context.task.sessionPlan, undefined);
    assert.deepEqual(
      context.state.conditions
        .filter((item) => item.scope === 'current')
        .map(({ scope: _scope, ...item }) => item),
      [
        {
          id: 'role',
          description: '非所有者且未绑定 GitHub',
          status: 'SATISFIED',
          source: 'human',
          evidenceRefs: [],
          controlRevision: 2,
        },
      ],
    );
    assert.match(body.messages[0].content, /前置条件满足不等于验收通过/);
    observations.push(context.page.observationId);
    const result = finish(context);
    if (turn === 2) result.criteria[0].verdict = 'FAILED';
    return result;
  });
  try {
    const settings = { ...config, modelUrl: server.url };
    const report = await execute(
      settings,
      client,
      new ChatModel(settings),
      execution,
    );
    assert.deepEqual(server.errors, []);
    assert.equal(report.verdict, 'FAILED');
    assert.deepEqual(
      report.steps.map((step) => step.status),
      ['COMPLETED', 'COMPLETED'],
    );
    assert.equal(new Set(observations).size, 2);
    assert.equal(client.requestedItems.length, 1);
    const afterHandoff = client.calls.slice(client.handoffs[0]);
    assert.equal(afterHandoff[0].operation.type, 'browser.observe');
    assert.ok(
      afterHandoff.every((call) => call.operation.type === 'browser.observe'),
    );
    assert.equal(report.executionDetails.actions, 1);
    assert.equal(report.steps[1].budgetUsage.actions, 0);
  } finally {
    await server.close();
  }
});

// 范围：交接早于首次导航时也保留人工页面；控制事件由夹具生成，不覆盖浏览器重启恢复。
test('初始导航前已交还人工页面时不会再次打开目标网址', async () => {
  const execution = caseGrant(['http://intranet.test/referral']);
  const client = new PageControl();
  await client.acknowledge();
  const report = await execute(
    config,
    client,
    scripted((context) => {
      assert.equal(context.page.url, client.url);
      assert.match(context.page.text, /人工准备好的页面/);
      return finish(context);
    }),
    execution,
  );
  assert.equal(report.verdict, 'PASSED');
  assert.equal(report.executionDetails.actions, 0);
});

// 范围：不同目标仍能进入，已到达的目标及站点重定向页面不会重复加载；不推断真实站点重定向规则。
test('步骤明确更换网址时按需导航，同入口保留重定向后的页面', async () => {
  const urls = [
    'http://intranet.test/a',
    'http://intranet.test/b',
    'http://intranet.test/b',
    'http://intranet.test/c',
  ];
  const execution = caseGrant(urls);
  const client = new PageControl();
  const seen = [];
  const report = await execute(
    config,
    client,
    scripted((context) => {
      const index = seen.length;
      seen.push(context.page.url);
      if (index === 1) {
        // 模拟站点内导航留下的语言路由，下一步仍声明原入口 b。
        client.url = 'http://intranet.test/zh/b';
        client.pageText = '保留团队空间';
      }
      if (index === 2) {
        assert.match(context.page.text, /保留团队空间/);
        // 模拟上一步已到达后续步骤的目标地址。
        client.url = urls[3];
      }
      return finish(context);
    }),
    execution,
  );
  assert.equal(report.verdict, 'PASSED');
  assert.deepEqual(seen, [
    urls[0],
    urls[1],
    'http://intranet.test/zh/b',
    urls[3],
  ]);
  assert.deepEqual(
    client.calls
      .filter((call) => call.operation.action === 'navigate')
      .map((call) => call.operation.target),
    urls.slice(0, 2),
  );
});

// 范围：切步准备跳转时出现人工交接，交接取消旧导航；不模拟网络分区或未知操作效果。
test('步骤切换期间人工交还页面会取消待执行导航', async () => {
  const execution = caseGrant([
    'http://intranet.test/a',
    'http://intranet.test/b',
  ]);
  const client = new PageControl();
  const record = client.recordSteps.bind(client);
  client.recordSteps = async (...args) => {
    await record(...args);
    if (args[1][1].status === 'RUNNING' && client.revision === 0)
      await client.acknowledge();
  };
  const report = await execute(
    config,
    client,
    scripted((context) => {
      if (context.task.stepId === 'step-2') {
        assert.equal(context.page.url, 'http://intranet.test/zh/referral');
        assert.match(context.page.text, /人工准备好的页面/);
      }
      return finish(context);
    }),
    execution,
  );
  assert.equal(report.verdict, 'PASSED');
  assert.ok(
    client.calls
      .slice(client.handoffs[0])
      .every((call) => call.operation.type === 'browser.observe'),
  );
});

// 范围：后续新条件不能借用前一步的人工证明，清理不重复要求身份；不模拟真实人工复核。
test('只传递当前步骤适用的确认，新条件仍需确认，清理不携带身份门禁', async () => {
  const execution = caseGrant(Array(3).fill('http://intranet.test/referral'));
  execution.task.environment.allowIntervention = true;
  execution.task.steps[0].preconditions = [
    { id: 'role', description: '非所有者', method: 'manual' },
  ];
  execution.task.steps[1].preconditions = [
    { id: 'github', description: '未绑定 GitHub', method: 'manual' },
  ];
  execution.task.cleanupStepIds = ['step-3'];
  execution.task.stepBudget = compileStepBudget(execution.task);
  const client = new PageControl();
  const seen = [];
  const report = await execute(
    config,
    client,
    scripted((context) => {
      seen.push(
        context.state.conditions
          .filter((item) => item.scope === 'current')
          .map(({ scope: _scope, ...item }) => item),
      );
      return finish(context);
    }),
    execution,
  );
  assert.equal(report.verdict, 'PASSED');
  assert.deepEqual(client.requestedItems, [['非所有者'], ['未绑定 GitHub']]);
  assert.equal(seen[0][0].id, 'role');
  assert.equal(seen[0][0].controlRevision, 2);
  assert.equal(seen[1][0].id, 'github');
  assert.equal(seen[1][0].controlRevision, 4);
  assert.deepEqual(seen[2], []);
});
