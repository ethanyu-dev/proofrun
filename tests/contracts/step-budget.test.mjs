import assert from 'node:assert/strict';
import test from 'node:test';
import { compileStepBudget, stepLimit } from '../../contracts/dist/index.js';

// 范围：按结构化验收项数量编译有界预算，准备/清理不膨胀；不模拟模型效率或生产耗时。
test('多验收项增加动作和模型额度，三十次动作封顶', () => {
  for (const executionMode of ['standard', 'jev']) {
    const task = {
      executionMode,
      cleanupStepIds: ['cleanup'],
      steps: [
        ...[1, 4, 8, 50].map((n) => ({
          stepId: `verify-${n}`,
          type: 'verification',
          expected: Array(n).fill('条件'),
        })),
        { stepId: 'setup', type: 'setup', expected: Array(8).fill('条件') },
        { stepId: 'cleanup', type: 'setup', expected: [] },
      ],
    };
    const plan = compileStepBudget(task);
    assert.deepEqual(
      plan.steps.map((s) => s.maxActions),
      [10, 16, 24, 30, 10],
    );
    assert.deepEqual(
      plan.steps.map((s) => s.maxModelCalls),
      [20, 32, 48, 60, 20].map((n) => n * (executionMode === 'jev' ? 2 : 1)),
    );
    assert(plan.steps.every((s) => s.timeoutMs === 300000));
    assert.equal(plan.cleanup.maxActions, 10);
    assert.equal(plan.cleanup.timeoutMs, 180000);
  }
});

// 范围：已有任务读冻结额度不自动扩容；不验证数据库重试事务。
test('已有任务冻结预算仍按原值读取', () => {
  const task = {
    cleanupStepIds: [],
    stepBudget: {
      steps: [
        { stepId: 'old', maxActions: 10, maxModelCalls: 20, timeoutMs: 300000 },
      ],
    },
  };
  assert.equal(stepLimit(task, 'old').maxActions, 10);
});
