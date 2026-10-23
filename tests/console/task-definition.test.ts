import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCaseBatch } from '../../apps/console/src/task-definition.ts';

// 范围：粘贴省略身份、约束和 setup 预期的数组可补齐后重试；不提交任务或验证登录复用。
test('v2 粘贴补齐非业务字段，保留原文且重试沿用身份', () => {
  const item = {
    platform: '邀请活动页',
    entry: 'https://example.test/referral',
    steps: [
      {
        type: 'setup',
        url: 'https://example.test/referral',
        exec_order: 1,
        description: '准备页面',
        policy: ['保持未登录'],
      },
      {
        type: 'verification',
        url: 'https://example.test/referral',
        exec_order: 2,
        description: '检查文案',
        expected: ['显示简体中文'],
      },
    ],
    cleanup: [],
    session: { mode: 'guest' },
  };
  const batch = parseCaseBatch(JSON.stringify([item, item]));
  assert.notEqual(batch[0]!.caseId, batch[1]!.caseId);
  assert.match(batch[0]!.caseId, /^case-[A-Za-z0-9_-]+$/);
  assert.deepEqual(batch[0], {
    ...item,
    caseId: batch[0]!.caseId,
    steps: [
      { ...item.steps[0], expected: [] },
      { ...item.steps[1], policy: [] },
    ],
  });
  assert.deepEqual(parseCaseBatch(JSON.stringify(batch)), batch);
  for (const invalid of [
    { ...item, caseId: null },
    { ...item, steps: [{ ...item.steps[1], expected: undefined }] },
    { ...item, steps: [{ ...item.steps[1], policy: null }] },
    { ...item, cleanup: undefined },
  ])
    assert.throws(
      () => parseCaseBatch(JSON.stringify([invalid])),
      /格式不正确/,
    );
  assert.throws(() => parseCaseBatch(JSON.stringify(item)), /格式不正确/);
  assert.throws(() => parseCaseBatch('[]'), /格式不正确/);
  assert.throws(
    () => parseCaseBatch(JSON.stringify(Array(33).fill(item))),
    /格式不正确/,
  );
});

// 范围：控制台 v2 批量导入使用共享 Schema 并拒绝重复身份；不调用真实提交接口或浏览器。
test('v2 粘贴可解析结构化 case 数组', () => {
  const item = {
    caseId: 'fixture',
    platform: '夹具',
    entry: 'https://example.test',
    steps: [
      {
        type: 'verification',
        url: 'https://example.test',
        exec_order: 1,
        description: '检查页面',
        policy: [],
        expected: ['页面可见'],
      },
    ],
    cleanup: [],
  };
  assert.deepEqual(parseCaseBatch(JSON.stringify([item])), [item]);
  assert.throws(() => parseCaseBatch(JSON.stringify([item, item])), /caseId/);
  assert.throws(
    () =>
      parseCaseBatch(
        JSON.stringify([
          { ...item, steps: [{ ...item.steps[0], expected: [] }] },
        ]),
      ),
    /格式不正确/,
  );
});
