import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionProgress } from '../../apps/agent/dist/execution/interaction-progress.js';
import { execute } from '../../apps/agent/dist/execution/runner.js';
import { config, grant, FakeControl, finish } from './fixture.mjs';

/** 用独立面板和悬浮控件构造观察，不代表真实站点 DOM。 */
function page() {
  return {
    url: 'https://fixture.test/faq',
    observationId: 'first',
    viewport: { width: 1000, height: 800 },
    truncated: false,
    artifactRefs: [{ artifactId: 'dom-1' }],
    targets: [
      {
        target: '@a',
        comparisonKey: 'faq-1',
        role: 'button',
        name: '展开',
        context: { heading: 'FAQ', fixed: false },
        disclosure: {
          relation: 'aria-controls',
          expanded: true,
          visible: true,
          text: '这是第一个问题的答案',
          truncated: false,
        },
      },
      {
        target: '@b',
        comparisonKey: 'faq-2',
        role: 'button',
        name: '展开',
        context: { heading: 'FAQ', fixed: false },
        disclosure: {
          relation: 'adjacent',
          expanded: false,
          visible: false,
          text: '',
          truncated: false,
        },
      },
      {
        target: '@c',
        comparisonKey: 'contact',
        role: 'button',
        name: '展开',
        context: { heading: '', fixed: true },
      },
    ],
  };
}

// 范围：引用必须来自本面板，隐藏内容/未知 ID 不可登记；不判断语言和业务验收是否通过。
test('逐项读取必须关联已观察原文，重复登记不推进且关闭后保留证据', () => {
  const ledger = new InteractionProgress();
  const observation = page();
  ledger.observe(observation);
  assert.equal(ledger.view().items.length, 2);
  for (const reading of [
    { itemId: 'item-2', quote: '这是第一个问题的答案' },
    { itemId: 'unknown', quote: '答案' },
    { itemId: 'item-1', quote: '页面全部符合要求' },
  ])
    assert.throws(() => ledger.validate([reading]), {
      code: 'INVALID_MODEL_DECISION',
    });
  const readings = [{ itemId: 'item-1', quote: '第一个问题的答案' }];
  ledger.record(ledger.validate(readings));
  ledger.record(ledger.validate(readings));
  assert.equal(ledger.view().revision, 1);
  observation.targets[0].disclosure = {
    ...observation.targets[0].disclosure,
    visible: false,
    text: '',
    expanded: false,
  };
  ledger.observe(observation);
  assert.equal(ledger.results()[0].status, 'recorded');
  assert.deepEqual(ledger.results()[0].evidenceRefs, ['dom-1']);
  assert.equal(ledger.results()[1].status, 'pending');
});

// 范围：目标编号复用、移出视口及重查例外；仅使用观察夹具，不验证真实页面滚动和控件行为。
test('阅读进度只绑定当前目标，已读点击必须说明重查原因', () => {
  const ledger = new InteractionProgress();
  const observation = page();
  ledger.observe(observation);
  ledger.record(
    ledger.validate([{ itemId: 'item-1', quote: '第一个问题的答案' }]),
  );
  assert.throws(() => ledger.assertClick(observation, observation.targets[0]), {
    code: 'INTERACTION_ALREADY_RECORDED',
  });
  ledger.assertClick(
    observation,
    observation.targets[0],
    '原任务要求核对收起行为',
  );
  const unread = structuredClone(observation.targets[1]);
  unread.target = '@a';
  observation.targets = [unread];
  ledger.observe(observation);
  assert.deepEqual(ledger.view().currentTargets, [
    { target: '@a', itemId: 'item-2', status: 'pending', failedAttempts: 0 },
  ]);
  ledger.assertClick(observation, unread);
  observation.targets = [];
  ledger.observe(observation);
  assert.deepEqual(ledger.view().currentTargets, []);
  assert.deepEqual(ledger.view().recordedItemIds, ['item-1']);
});

// 范围：重查声明不绕过点击失败围栏，非法理由不修改工作流；不验证自然语言理由是否符合业务要求。
test('重查理由仍须经过工作流与浏览器前置校验', async () => {
  const { Workflow } =
    await import('../../apps/agent/dist/execution/workflow.js');
  const workflow = new Workflow('核对展开和收起');
  for (const revisitReason of ['', '   ', 123, '长'.repeat(601)])
    assert.throws(() => workflow.apply({ revisitReason }, new Set()), {
      code: 'INVALID_MODEL_DECISION',
    });
  assert.throws(
    () =>
      workflow.apply({ revisitReason: '原任务要求核对收起行为' }, new Set()),
    { code: 'INVALID_MODEL_DECISION' },
  );
  const ledger = new InteractionProgress();
  const observation = page();
  ledger.observe(observation);
  ledger.record(
    ledger.validate([{ itemId: 'item-1', quote: '第一个问题的答案' }]),
  );
  ledger.failedClick(observation, observation.targets[0]);
  assert.throws(
    () => ledger.assertClick(observation, observation.targets[0], '核对收起'),
    { code: 'INTERACTION_RECOVERY_REQUIRED' },
  );
});

// 范围：裁剪内容不得完成读取；不覆盖节点是否准确标记裁剪。
test('不采信裁剪正文或没有证据附件的面板', () => {
  for (const kind of ['panel', 'page', 'artifact']) {
    const observation = page();
    if (kind === 'panel') observation.targets[0].disclosure.truncated = true;
    if (kind === 'page') observation.truncated = true;
    if (kind === 'artifact') observation.artifactRefs = [];
    const ledger = new InteractionProgress();
    ledger.observe(observation);
    assert.throws(
      () => ledger.validate([{ itemId: 'item-1', quote: '答案' }]),
      { code: 'INVALID_MODEL_DECISION' },
    );
  }
});

// 范围：刷新观察编号不算恢复，真实条件改变才允许第二次尝试且仍有硬上限；不派发真实点击。
test('失败目标只有条件变化才可重试，同目标最多两次前置失败', () => {
  const ledger = new InteractionProgress();
  const observation = page();
  ledger.failedClick(observation, observation.targets[0], 'TARGET_OBSCURED');
  observation.observationId = 'new-id';
  assert.throws(() => ledger.assertClick(observation, observation.targets[0]), {
    code: 'INTERACTION_RECOVERY_REQUIRED',
  });
  observation.viewport.height = 600;
  ledger.assertClick(observation, observation.targets[0]);
  ledger.failedClick(observation, observation.targets[0]);
  observation.viewport.height = 500;
  assert.throws(() => ledger.assertClick(observation, observation.targets[0]), {
    code: 'INTERACTION_RECOVERY_REQUIRED',
  });
  ledger.assertClick(observation, observation.targets[1]);
});

// 范围：同一批控件滚动后位置改变可重试，单纯更新观察编号仍拒绝；不模拟实际遮罩或点击成功率。
test('滚动改变可见矩形后允许有界点击恢复', () => {
  const ledger = new InteractionProgress();
  const observation = page();
  const target = observation.targets[1];
  target.clip = { left: 0, top: 0, right: 600, bottom: 20 };
  ledger.observe(observation);
  ledger.failedClick(observation, target, 'TARGET_OBSCURED');
  observation.observationId = 'new-observation';
  assert.throws(() => ledger.assertClick(observation, target), {
    code: 'INTERACTION_RECOVERY_REQUIRED',
  });
  target.clip = { left: 0, top: 200, right: 600, bottom: 240 };
  ledger.assertClick(observation, target);
  assert.equal(ledger.view().currentTargets[1].failedAttempts, 1);
  ledger.failedClick(observation, target);
  target.clip.top = 300;
  assert.throws(() => ledger.assertClick(observation, target), {
    code: 'INTERACTION_RECOVERY_REQUIRED',
  });
});

// 范围：大量子项不会挤爆模型上下文，裁剪只作用于副本；不模拟供应商 token 计费。
test('子项进度可裁剪但执行器保留完整报告来源', async () => {
  const { decisionContext } =
    await import('../../apps/agent/dist/execution/context.js');
  const { grant } = await import('./fixture.mjs');
  const observation = {
    ...page(),
    text: '夹具页面',
    title: 'FAQ',
    atomic: false,
  };
  const first = observation.targets[0];
  observation.targets = Array.from({ length: 32 }, (_, i) => ({
    ...first,
    comparisonKey: `question-${i}`,
    name: `问题${i}`,
    disclosure: { ...first.disclosure, text: '答案内容'.repeat(100) },
  }));
  const ledger = new InteractionProgress();
  ledger.observe(observation);
  const input = {
    task: grant().task,
    current: observation,
    preconditions: [],
    workflow: undefined,
    interactionProgress: ledger.view(),
    budgetRemaining: { actions: 20, modelCalls: 40, timeMs: 300000 },
    evidence: [],
    history: [],
    previousObservations: [],
    feedback: null,
    maxContextChars: 4000,
  };
  const context = decisionContext(input);
  assert(context.text.length <= 4000);
  assert(JSON.parse(context.text).state.readings.omittedItems > 0);
  assert.equal(JSON.parse(context.text).state.readings.discovered, 32);
  assert.equal(
    JSON.parse(context.text).state.readings.unreadItemIds.length,
    32,
  );
  assert.equal(ledger.results().length, 32);
  assert.equal(ledger.view().items[0].text.length, 400);
});

// 范围：空白排版差异可登记且报告保留原文，重复提交不推进；不容忍字词改写，也不验证真实 FAQ 内容。
test('FAQ 引文只规范化空白，已登记子项重复提交保留首次原文', () => {
  const ledger = new InteractionProgress();
  const observation = page();
  const original = '1. Reward ($1).\n\n2. Use [A+B] vouchers.';
  observation.targets[0].disclosure.text = original;
  ledger.observe(observation);
  ledger.record(ledger.validate([{ itemId: 'item-1', quote: original }]));
  ledger.record(
    ledger.validate([
      { itemId: 'item-1', quote: '1. Reward ($1). 2. Use [A+B] vouchers.' },
    ]),
  );
  assert.equal(ledger.view().revision, 1);
  assert.deepEqual(ledger.view().recordedItemIds, ['item-1']);
  assert.equal(ledger.results()[0].quote, original);
  const fresh = new InteractionProgress();
  fresh.observe(observation);
  fresh.record(
    fresh.validate([
      { itemId: 'item-1', quote: '1. Reward ($1).\t2. Use [A+B] vouchers.' },
    ]),
  );
  assert.equal(fresh.results()[0].quote, original);
  for (const quote of [
    '1. Reward ($2). 2. Use [A+B] vouchers.',
    '1. Reward ($1). 2. Use AAB vouchers.',
    '1. Reward ($1). 3. Use [A+B] vouchers.',
  ])
    assert.throws(() => ledger.validate([{ itemId: 'item-1', quote }]), {
      code: 'INVALID_MODEL_DECISION',
    });
});

// 范围：裁剪不会丢失已登记身份或修改输入；超长原文不能靠归一化绕过引文上限，不覆盖供应商上下文限制。
test('裁剪保留全部已登记身份且不污染输入进度', async () => {
  const { decisionContext } =
    await import('../../apps/agent/dist/execution/context.js');
  const { grant } = await import('./fixture.mjs');
  const observation = {
    ...page(),
    text: '夹具页面',
    title: 'FAQ',
    atomic: false,
  };
  const first = observation.targets[0];
  observation.targets = Array.from({ length: 12 }, (_, i) => ({
    ...first,
    comparisonKey: `faq-${i}`,
    name: `问题${i}`,
    disclosure: { ...first.disclosure, text: '已读答案'.repeat(90) },
  }));
  const ledger = new InteractionProgress();
  ledger.observe(observation);
  ledger.record(
    ledger.validate(
      ledger.view().items.map((item) => ({
        itemId: item.id,
        quote: '已读答案'.repeat(90),
      })),
    ),
  );
  const progress = ledger.view();
  const before = structuredClone(progress);
  const result = JSON.parse(
    decisionContext({
      task: grant().task,
      current: observation,
      preconditions: [],
      interactionProgress: progress,
      budgetRemaining: { actions: 20, modelCalls: 40, timeMs: 300000 },
      evidence: [],
      history: [],
      previousObservations: [],
      feedback: null,
      maxContextChars: 4000,
    }).text,
  );
  assert(result.state.readings.omittedItems > 0);
  assert.deepEqual(
    result.state.readings.recordedItemIds,
    before.recordedItemIds,
  );
  assert.deepEqual(progress, before);
  const long = page();
  long.targets[0].disclosure.text = 'A' + '\n'.repeat(600) + 'B';
  const bounded = new InteractionProgress();
  bounded.observe(long);
  assert.throws(() => bounded.validate([{ itemId: 'item-1', quote: 'A B' }]), {
    code: 'INVALID_MODEL_DECISION',
  });
});

// 范围：复现登记后误点已读题、纠正滚动、编号复用到新题的执行链路；所有页面和模型响应均为夹具。
test('执行器阻止已读题重点击，滚动后用新目标继续读取', async () => {
  const client = new FakeControl();
  const command = client.command.bind(client);
  let scrolled = false;
  let opened = false;
  client.command = async (...args) => {
    const operation = args[2];
    if (operation.type === 'browser.act' && operation.action === 'scroll')
      scrolled = true;
    if (operation.type === 'browser.act' && operation.action === 'click')
      opened = true;
    const result = await command(...args);
    if (operation.type === 'browser.observe') {
      const target = structuredClone(page().targets[scrolled ? 1 : 0]);
      target.target = '@a';
      if (scrolled && opened)
        target.disclosure = {
          ...target.disclosure,
          visible: true,
          expanded: true,
          text: '第二题答案',
        };
      result.data.targets = [target];
      result.data.text = scrolled
        ? opened
          ? '第二题答案'
          : '第二题待展开'
        : '第一题答案已显示';
    }
    return result;
  };
  let turn = 0;
  const report = await execute(
    { ...config, maxTurns: 10 },
    client,
    {
      async decide(input) {
        const context = JSON.parse(input.text);
        let decision, workflow;
        if (++turn === 1) {
          decision = { type: 'browser.act', action: 'click', target: '@a' };
          workflow = {
            readings: [{ itemId: 'item-1', quote: '第一个问题的答案' }],
          };
        } else if (turn === 2) {
          assert.match(
            context.feedback.map((item) => item.message ?? item.code).join(' '),
            /INTERACTION_ALREADY_RECORDED/,
          );
          assert.equal(
            client.calls.filter((c) => c.operation.action === 'click').length,
            0,
          );
          decision = { type: 'browser.act', action: 'scroll', value: 'down' };
        } else if (turn === 3) {
          assert.equal(
            context.state.readings.currentTargets[0].itemId,
            'item-2',
          );
          decision = { type: 'browser.act', action: 'click', target: '@a' };
        } else {
          decision = finish(context);
          workflow = { readings: [{ itemId: 'item-2', quote: '第二题答案' }] };
        }
        return {
          decision: {
            ...decision,
            progress: { ...decision.progress, ...workflow },
          },
          promptTokens: 0,
          completionTokens: 0,
        };
      },
    },
    grant(),
  );
  assert.equal(report.verdict, 'PASSED');
  // 启动导航也计入动作；被拦截的重复点击不能进入节点或消耗动作额度。
  assert.equal(report.executionDetails.actions, 3);
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'scroll').length,
    1,
  );
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'click').length,
    1,
  );
});

// 范围：阅读进度在下一动作前连同步骤附件持久化，模拟控制面的引用包含校验；不证明真实网页业务结果。
test('同轮保存阅读进度时同步步骤证据，再派发动作', async () => {
  const execution = grant();
  execution.task.steps = [
    {
      stepId: 'read',
      type: 'verification',
      url: execution.task.target.url,
      exec_order: 1,
      description: '阅读面板并填写名称',
      policy: [],
      expected: ['页面结果可见'],
    },
  ];
  execution.task.acceptanceCriteria[0].stepId = 'read';
  const client = new FakeControl();
  const command = client.command.bind(client);
  let persisted = false;
  client.command = async (...args) => {
    if (args[2].action === 'fill')
      assert(persisted, '填写前必须成功保存阅读来源');
    const result = await command(...args);
    if (args[2].type === 'browser.observe')
      result.data.targets[1].disclosure = {
        relation: 'aria-controls',
        expanded: true,
        visible: true,
        text: '真实面板原文',
        truncated: false,
      };
    return result;
  };
  const record = client.recordSteps.bind(client);
  client.recordSteps = async (g, steps) => {
    for (const step of steps)
      for (const reading of step.readings ?? []) {
        assert(
          reading.evidenceRefs.every((id) => step.evidenceRefs.includes(id)),
          '阅读证据必须属于步骤附件集合',
        );
        if (reading.status === 'recorded') persisted = true;
      }
    return record(g, steps);
  };
  let turn = 0;
  const report = await execute(
    config,
    client,
    {
      async decide(input) {
        const ctx = JSON.parse(input.text);
        return {
          decision:
            ++turn === 1
              ? {
                  type: 'browser.act',
                  action: 'fill',
                  target: '@e1',
                  value: 'Alice',
                  progress: {
                    readings: [{ itemId: 'item-1', quote: '真实面板原文' }],
                  },
                }
              : finish(ctx),
          promptTokens: 0,
          completionTokens: 0,
        };
      },
    },
    execution,
  );
  assert(persisted);
  assert.equal(report.verdict, 'PASSED', JSON.stringify(report));
  assert.equal(
    client.calls.filter((call) => call.operation.action === 'fill').length,
    1,
  );
});
