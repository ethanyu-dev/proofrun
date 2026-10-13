import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  compileProfilePlan,
  validateVerificationTask,
} from '../../contracts/dist/index.js';

/** 使用已有合法任务验证内部计划边界，不模拟模型或浏览器。 */
const fixture = JSON.parse(
  readFileSync(
    new URL('../scenarios/basic-form/task.json', import.meta.url),
    'utf8',
  ),
);

/** 每个 setup 开启独立组；后续验证必须保持组内顺序。 */
function steps(count) {
  return Array.from({ length: count }, (_, i) => [
    { stepId: `setup-${i}`, type: 'setup' },
    { stepId: `verify-${i}`, type: 'verification' },
  ]).flat();
}

// 范围：按组数选择并发、八组封顶且保留分组顺序；不衡量真实页面速度或账号隔离。
test('新计划充分利用八个并发名额，少量组按实际数量运行', () => {
  for (const count of [1, 2, 5, 8, 9, 32]) {
    const plan = compileProfilePlan(steps(count));
    assert.equal(plan.maxConcurrency, Math.min(count, 8));
    assert.deepEqual(
      plan.groups,
      Array.from({ length: count }, (_, i) => ({
        id: `group-${i + 1}`,
        stepIds: [`setup-${i}`, `verify-${i}`],
      })),
    );
  }
});

// 范围：协议接受新上限和旧冻结并发值，拒绝越界及非整数；不验证任务持久化或运行时调度。
test('协议支持八组并发并兼容旧计划', () => {
  const plan = compileProfilePlan(steps(9));
  for (const maxConcurrency of [1, 2, 4, 8, 0, 9, 1.5]) {
    const task = { ...fixture, profilePlan: { ...plan, maxConcurrency } };
    assert.equal(
      validateVerificationTask(task),
      [1, 2, 4, 8].includes(maxConcurrency),
    );
  }
});
