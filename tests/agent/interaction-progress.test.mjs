import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionProgress } from '../../apps/agent/dist/execution/interaction-progress.js';

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
  assert(JSON.parse(context.text).interactionProgress.omittedItems > 0);
  assert.equal(ledger.results().length, 32);
  assert.equal(ledger.view().items[0].text.length, 400);
});
