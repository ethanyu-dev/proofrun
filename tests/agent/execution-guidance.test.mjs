import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionGuidance } from '../../apps/agent/dist/execution/execution-guidance.js';
import {
  NavigationMemory,
  scrollDistance,
} from '../../apps/agent/dist/execution/navigation-memory.js';
import { Workflow } from '../../apps/agent/dist/execution/workflow.js';
import { execute } from '../../apps/agent/dist/execution/runner.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { JevModel } from '../../apps/agent/dist/model/jev.js';
import { config, grant, FakeControl, finish, modelServer } from './fixture.mjs';
import { compileStepBudget } from '../../contracts/dist/index.js';

/** 合成观察用不同名称、语言和 URL 复用同一机制，不代表真实网站验收。 */
function page(id, text = 'A', extra = {}) {
  return {
    observationId: id,
    url: 'https://fixture.test/catalog',
    title: '目录',
    text,
    targets: [],
    atomic: false,
    artifactRefs: [],
    viewport: { y: 0, height: 800, width: 1000, scrollDistance: true },
    ...extra,
  };
}
/** 子目标只引用原要求；初始预算是局部限制而非新增额度。 */
const plan = {
  goal: '定位并核对剩余内容',
  scope: '',
  terms: ['字段'],
  successCondition: '观察到要求中的结果',
  maxActions: 6,
  phase: 'interact',
  criterionIds: ['criterion'],
};
function workflow() {
  const w = new Workflow('核对所有要求', undefined, undefined, true);
  w.apply({ recovery: plan }, new Set(), 10, new Set(['criterion']));
  return w;
}
function input(observation, overrides = {}) {
  return {
    page: observation,
    workflow: workflow().view(),
    pending: ['criterion'],
    progressKey: '0',
    scope: 'tab-one:step-one:control-one',
    budget: { actions: 20, modelCalls: 20, timeMs: 60_000 },
    ...overrides,
  };
}

// 范围：共享检测识别滚动、分页、面板等往返；合成状态不证明真实模型能恢复。
for (const [name, states] of [
  ['长页面', ['顶部', '底部', '顶部']],
  ['分页列表', ['第1页', '第2页', '第1页']],
  ['菜单', ['closed', 'open', 'closed']],
  ['多语言', ['日本語', 'Deutsch', '日本語']],
]) {
  test(`${name} 往返在恢复计划内同样触发复核`, () => {
    const g = new ExecutionGuidance();
    const views = states.map((state, i) =>
      g.view(input(page(String(i), state))),
    );
    assert.equal(views.at(-1).review, 'STATE_CYCLE');
    assert.equal(views.at(-1).progress.currentStateVisits, 2);
  });
}

// 范围：模型重试、重规划不增加观察次数；同一观察输入不代表实际执行动作。
test('重试和改写计划不清空循环历史', () => {
  const g = new ExecutionGuidance();
  g.view(input(page('1', 'A')));
  g.view(input(page('1', 'A')));
  assert.equal(g.view(input(page('2', 'B'))).progress.retainedStates, 2);
  const v = g.view(
    input(page('3', 'A'), {
      workflow: {
        ...workflow().view(),
        recovery: { ...plan, id: 'changed', remaining: 6 },
      },
    }),
  );
  assert.equal(v.review, 'STATE_CYCLE');
});

// 范围：真实账本变化允许合理回访；不验证模型提交证据的业务含义。
test('新证据允许回访但计划换名不构成进展', () => {
  const g = new ExecutionGuidance();
  g.view(input(page('1', 'A')));
  g.view(input(page('2', 'B')));
  const view = g.view(
    input(page('3', 'A'), { progressKey: 'recorded-criterion' }),
  );
  assert.equal(view.review, 'TASK_PROGRESS');
  assert.equal(view.progress.currentStateVisits, 1);
});

// 范围：动态观察编号、目标编号和像素布局不制造进展；不覆盖任意动态业务文本。
test('动画几何和临时目标编号不掩盖状态停滞', () => {
  const g = new ExecutionGuidance();
  let view;
  for (let i = 0; i < 3; i++)
    view = g.view(
      input(
        page(String(i), `文字 [target=${i}]`, {
          targets: [
            {
              target: String(i),
              role: 'button',
              name: '下一步',
              clip: { left: i, top: i, right: i + 1, bottom: i + 1 },
            },
          ],
        }),
      ),
    );
  assert.equal(view.review, 'STATE_CYCLE');
});

// 范围：计划预算和动作白名单由执行器检查；不代表任意自然语言约束都能静态判定。
test('计划跨动作生效，换措辞和人工失效不能重置同阶段额度', () => {
  const w = workflow();
  const firstId = w.view().recovery.id;
  for (let i = 0; i < 6; i++) w.acted();
  w.invalidateRecovery();
  w.apply(
    { recovery: { ...plan, goal: '换一个措辞寻找内容' } },
    new Set(),
    10,
    new Set(['criterion']),
  );
  assert.equal(w.view().recovery.remaining, 0);
  assert.notEqual(w.view().recovery.id, firstId);
  assert.throws(
    () =>
      w.assertAction({ type: 'browser.act', action: 'scroll', value: 'up' }),
    /耗尽/,
  );
  w.creditProgress({ workflow: 0, reading: 1, criteria: [] });
  w.apply(
    { recovery: { ...plan, allowedActions: ['fill'] } },
    new Set(),
    10,
    new Set(['criterion']),
  );
  assert.equal(w.view().recovery.remaining, 6);
  assert.throws(
    () => w.assertAction({ type: 'browser.act', action: 'click' }),
    /超出/,
  );
});

// 范围：未知原标准、超预算和无计划动作被拒绝，原计划状态原子保留。
test('非法计划不能改写要求或借预算', () => {
  const w = workflow(),
    original = w.view();
  assert.throws(() =>
    w.apply(
      { recovery: { ...plan, criterionIds: ['invented'] } },
      new Set(),
      10,
      new Set(['criterion']),
    ),
  );
  assert.deepEqual(w.view(), original);
  assert.throws(() =>
    w.apply({ recovery: plan }, new Set(), 2, new Set(['criterion'])),
  );
  w.invalidateRecovery();
  assert.throws(
    () => w.assertAction({ type: 'browser.act', action: 'click' }),
    /子目标/,
  );
});

// 范围：节点能力协商和不同视口/容器尺寸；不证明滚动后目标必然出现。
test('滚动幅度按能力和实际容器计算，旧节点兼容', () => {
  assert.equal(scrollDistance(page('1')), 600);
  assert.equal(
    scrollDistance(
      page('2', '', { viewport: { height: 2000, scrollDistance: true } }),
    ),
    1200,
  );
  assert.equal(
    scrollDistance(page('3', '', { viewport: { height: 800 } })),
    400,
  );
  assert.equal(
    scrollDistance(
      page('4', '', {
        targets: [{ target: 'list', scroll: { width: 300, height: 200 } }],
      }),
      'list',
    ),
    180,
  );
});

// 范围：合成列表几何可连续扫描至末端，并在冻结额度内保留导航、选择及查询；不替代真实虚拟 DOM 和模型测评。
test('窄容器扫描保留重叠并给最终操作留下额度', () => {
  const budget = compileStepBudget({
    executionMode: 'llm',
    steps: [
      { stepId: 'verify', type: 'verification', expected: ['查询实际记录'] },
    ],
  }).steps[0];
  const observation = page('list', '', {
    targets: [{ target: 'list', scroll: { width: 300, height: 240 } }],
  });
  const stride = scrollDistance(observation, 'list');
  const windows = [0];
  while (windows.at(-1) + 240 < 1920) windows.push(windows.at(-1) + stride);
  assert.ok(
    windows.slice(1).every((position, i) => position < windows[i] + 240),
    '相邻视口仍有重叠',
  );
  assert.ok(
    windows.length - 1 + 3 <= budget.maxActions,
    '导航及末尾选择、查询均计入预算',
  );
  assert.equal(scrollDistance(observation, 'list', true), 270);
  assert.ok(
    scrollDistance(
      page('tiny', '', {
        targets: [{ target: 'list', scroll: { width: 50, height: 50 } }],
      }),
      'list',
    ) < 50,
  );
  assert.equal(
    scrollDistance(
      page('large', '', {
        targets: [{ target: 'list', scroll: { width: 2000, height: 2000 } }],
      }),
      'list',
    ),
    1200,
  );
});

// 范围：历史线索隔离 URL、frame 与嵌套坐标；不保存旧操作身份或表单输入值。
test('位置记忆只指路，不能提供可重放目标', () => {
  const memory = new NavigationMemory();
  memory.observe(
    page('1', '', {
      targets: [
        {
          target: 'old-secret-target',
          name: 'Account field',
          role: 'textbox',
          value: 'private-value',
          clip: { top: 100, left: 10, right: 200, bottom: 130 },
        },
      ],
    }),
  );
  const next = page('2', '', {
    viewport: { y: 2400, height: 800, scrollDistance: true },
  });
  const hints = memory.hints(next, ['account']);
  assert.equal(hints[0].direction, 'up');
  assert.equal(hints[0].estimatedScrolls, 4);
  assert(!JSON.stringify(hints).includes('old-secret-target'));
  assert(!JSON.stringify(hints).includes('private-value'));
  assert.deepEqual(
    memory.hints({ ...next, url: 'https://other.test' }, ['account']),
    [],
  );
  memory.observe(
    page('3', '', {
      targets: [
        {
          target: 'nested',
          role: 'textbox',
          name: '日本語欄',
          frame: 'child',
          clip: { top: 20 },
        },
      ],
    }),
  );
  assert.equal(memory.hints(next, ['日本語'])[0].documentY, null);
});

// 范围：早期成本提示不改变硬预算，不把不确定估算当作不可执行结论。
test('返回距离触发工作预算复核，未知路径不伪造估算', () => {
  const g = new ExecutionGuidance();
  const w = workflow().view();
  w.recovery.terms = ['字段'];
  g.view(
    input(
      page('1', '', {
        targets: [
          { target: 'x', name: '字段', role: 'textbox', clip: { top: 100 } },
        ],
      }),
      { workflow: w },
    ),
  );
  const view = g.view(
    input(
      page('2', '远处', {
        viewport: { y: 2400, height: 800, scrollDistance: true },
      }),
      { workflow: w, budget: { actions: 6, modelCalls: 20, timeMs: 60_000 } },
    ),
  );
  assert.equal(view.review, 'WORK_BUDGET_LOW');
  assert.equal(view.budget.actions, 6);
  assert.equal(
    new ExecutionGuidance().view(input(page('1'))).budget.estimatedActions,
    null,
  );
});

// 范围：人工控制代次和 tab 隔离，不把前页位置用于新上下文。
test('控制权与执行范围变更后失效定位线索', () => {
  const g = new ExecutionGuidance();
  g.view(input(page('1', 'A')));
  g.view(input(page('2', 'B')));
  assert.equal(
    g.view(input(page('3', 'A'), { scope: 'other-tab' })).review,
    null,
  );
});

// 范围：真实 Chat HTTP 协议与公共执行器；模型回复和浏览器均为夹具，不是外部网站验收。
test('LLM 在同一调用规划并动作，后续沿用且审计保存策略版本', async () => {
  const server = await modelServer((context, turn, body) => {
    assert.equal(context.executionGuidance.version, 'evidence-settlement-v2');
    if (turn === 1) {
      assert(
        body.tools
          .find((tool) => tool.function.name === 'browser_act')
          .function.parameters.required.includes('workflow'),
      );
      return {
        type: 'browser.act',
        action: 'fill',
        target: '@e1',
        value: 'Alice',
        workflow: {
          recovery: { ...plan, criterionIds: ['submitted'], maxActions: 3 },
        },
      };
    }
    if (turn === 2) {
      assert.equal(context.workflow.recovery.remaining, 2);
      return { type: 'browser.act', action: 'click', target: '@e2' };
    }
    return finish(context);
  });
  try {
    const client = new FakeControl(),
      settings = { ...config, modelUrl: server.url, executionGuidance: true };
    const report = await execute(
      settings,
      client,
      new ChatModel(settings),
      grant(),
    );
    assert.deepEqual(server.errors, []);
    assert.equal(report.verdict, 'PASSED');
    assert.equal(
      client.calls.filter((call) => call.operation.action === 'click').length,
      1,
    );
    assert(
      client.modelCalls.some(
        (call) =>
          call.body.phase === 'start' &&
          call.body.record.request.includes('evidence-settlement-v2'),
      ),
    );
  } finally {
    await server.close();
  }
});

// 范围：JEV 复核路由不访问真实供应商，验证持续计划交接而非模型能力。
test('JEV 在公共执行器要求重规划时交给文本模型', async () => {
  let reviews = 0;
  const model = new JevModel(
    config,
    'fixture-key',
    undefined,
    async () => {
      throw Error('不应请求候选服务');
    },
    {
      decide: async (request) => {
        reviews++;
        assert(JSON.parse(request.text).feedback.includes('PLAN_REQUIRED'));
        return {
          decision: { type: 'browser.observe' },
          promptTokens: 0,
          completionTokens: 0,
        };
      },
    },
  );
  const context = {
    task: { objective: '任意任务' },
    observation: page('1'),
    workflow: { ...workflow().view(), recovery: null },
    executionGuidance: { review: 'PLAN_REQUIRED' },
    recentOperations: [],
    budgetRemaining: { actions: 10 },
  };
  await model.decide(
    { text: JSON.stringify(context) },
    new AbortController().signal,
  );
  assert.equal(reviews, 1);
});

// 范围：模型回传历史节点幅度时重新按当前视口计算；真实浏览器移动由 Chromium 回归另验。
test('滚动回执格式不会污染下一轮动作意图，执行器重算幅度', async () => {
  const server = await modelServer((context, turn) => {
    if (turn === 1)
      return {
        type: 'browser.act',
        action: 'scroll',
        value: 'down:475',
        workflow: {
          recovery: { ...plan, criterionIds: ['submitted'], maxActions: 4 },
        },
      };
    if (turn === 2)
      return {
        type: 'browser.act',
        action: 'fill',
        target: '@e1',
        value: 'Alice',
      };
    if (turn === 3)
      return { type: 'browser.act', action: 'click', target: '@e2' };
    return finish(context);
  });
  try {
    const client = new FakeControl(),
      command = client.command.bind(client);
    client.command = async (...args) => {
      const result = await command(...args);
      if (args[2].type === 'browser.observe')
        result.data.viewport = {
          height: 800,
          width: 1000,
          scrollDistance: true,
        };
      return result;
    };
    const settings = {
      ...config,
      modelUrl: server.url,
      executionGuidance: true,
    };
    const report = await execute(
      settings,
      client,
      new ChatModel(settings),
      grant(),
    );
    assert.deepEqual(server.errors, []);
    assert.equal(report.verdict, 'PASSED');
    assert.equal(
      client.calls.find((call) => call.operation.action === 'scroll').operation
        .value,
      'down:600',
    );
  } finally {
    await server.close();
  }
});

// 范围：拒绝未知动作并给出精确修正反馈，不放开 observe 的动作授权。
test('计划动作枚举错误不会以笼统恢复错误掩盖', () => {
  const w = workflow(),
    before = w.view();
  assert.throws(
    () =>
      w.apply(
        { recovery: { ...plan, allowedActions: ['scroll', 'observe'] } },
        new Set(),
        10,
        new Set(['criterion']),
      ),
    /observe\/wait\/verification/,
  );
  assert.deepEqual(w.view(), before);
  assert.throws(
    () =>
      w.apply(
        { recovery: { ...plan, remaining: 6 } },
        new Set(),
        10,
        new Set(['criterion']),
      ),
    /只读/,
  );
});

// 范围：空白区域中的实际滚动是定位变化；不会自动增加验收完成度。
test('新滚动区域不误报循环，返回原区域仍可识别', () => {
  const g = new ExecutionGuidance();
  for (const y of [0, 400, 800]) {
    const v = g.view(
      input(page(String(y), '相同全文', { viewport: { y, height: 800 } })),
    );
    assert.notEqual(v.review, 'STATE_CYCLE');
  }
  assert.equal(
    g.view(
      input(page('back', '相同全文', { viewport: { y: 400, height: 800 } })),
    ).review,
    'STATE_CYCLE',
  );
});

// 范围：人工交接缩减记录后恢复旧记录不能重复领取局部额度；不模拟人工浏览器操作。
test('权威账本缩减或恢复旧事实不刷新尝试预算', () => {
  const w = workflow();
  w.creditProgress({ workflow: 0, reading: 1, criteria: ['criterion'] });
  for (let i = 0; i < 6; i++) w.acted();
  for (const progress of [
    { workflow: 0, reading: 0, criteria: [] },
    { workflow: 0, reading: 1, criteria: ['criterion'] },
  ]) {
    w.creditProgress(progress);
    w.apply(
      { recovery: { ...plan, goal: '再次尝试' } },
      new Set(),
      10,
      new Set(['criterion']),
    );
    assert.equal(w.view().recovery.remaining, 0);
  }
});

// 范围：一个验收项内先填写再下一步属于不同子目标；真实页面变化允许新尝试，文字改名不允许。
test('同一验收项的后续子目标可在真实状态变化后获得局部额度', () => {
  const w = new Workflow('完成配置', undefined, undefined, true);
  w.observeState(page('a', '名称为空'));
  w.apply(
    { recovery: { ...plan, goal: '填写名称', maxActions: 1 } },
    new Set(),
    10,
    new Set(['criterion']),
  );
  w.acted();
  w.observeState(page('a-retry', '名称为空'));
  w.apply(
    { recovery: { ...plan, goal: '下一步', maxActions: 2 } },
    new Set(),
    9,
    new Set(['criterion']),
  );
  assert.equal(w.view().recovery.remaining, 0);
  w.observeState(page('b', '名称为 Atlas'));
  w.apply(
    { recovery: { ...plan, goal: '点击下一步进入通知配置', maxActions: 2 } },
    new Set(),
    9,
    new Set(['criterion']),
  );
  assert.equal(w.view().recovery.remaining, 2);
  w.acted();
  w.observeState(page('a-return', '名称为空'));
  w.apply(
    { recovery: { ...plan, goal: '换句话填写名称', maxActions: 1 } },
    new Set(),
    8,
    new Set(['criterion']),
  );
  assert.equal(w.view().recovery.remaining, 0);
});

// 范围：同一计划跨页面状态重送仍消耗原位置额度；不验证模型是否选择合理的新子目标。
test('重送同一计划不转移已消费预算的归属', () => {
  const w = new Workflow('完成配置', undefined, undefined, true);
  const recovery = { ...plan, maxActions: 3 };
  let id;
  for (const state of ['A', 'B', 'C']) {
    w.observeState(page(state, state));
    w.apply({ recovery }, new Set(), 10, new Set(['criterion']));
    id ??= w.view().recovery.id;
    assert.equal(w.view().recovery.id, id);
    w.acted();
  }
  assert.equal(w.view().recovery.remaining, 0);
  w.observeState(page('return', 'A'));
  w.apply(
    { recovery: { ...recovery, goal: '改名重试' } },
    new Set(),
    7,
    new Set(['criterion']),
  );
  assert.equal(w.view().recovery.remaining, 0);
  w.observeState(page('next', 'D'));
  w.apply(
    { recovery: { ...recovery, goal: '新的子目标' } },
    new Set(),
    7,
    new Set(['criterion']),
  );
  assert.equal(w.view().recovery.remaining, 3);
});
