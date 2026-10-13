import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executionDeadline,
  executionTimeoutCode,
} from '../src/modules/scheduling/execution-time.js';

// 范围：只验证时钟选择及原因优先级，不模拟调度延迟和真实人工处理。
test('人工等待暂停业务预算，但不能延长更早的清理截止时间', () => {
  const context = {
    control_mode: 'HUMAN',
    deadline_at: new Date(1000),
    human_deadline_at: new Date(3000),
  };
  assert.equal(executionDeadline(context), 3000);
  assert.equal(executionTimeoutCode(context), 'HUMAN_INTERVENTION_TIMEOUT');
  assert.equal(
    executionDeadline({ ...context, human_deadline_at: null }),
    Infinity,
  );
  assert.equal(
    executionTimeoutCode({ ...context, cleanup_deadline_at: new Date(2000) }),
    'CLEANUP_DEADLINE_EXCEEDED',
  );
  assert.equal(
    executionTimeoutCode({ ...context, cleanup_deadline_at: new Date(4000) }),
    'HUMAN_INTERVENTION_TIMEOUT',
  );
  assert.equal(executionDeadline({ ...context, control_mode: 'AUTO' }), 1000);
  assert.equal(
    executionTimeoutCode({ ...context, control_mode: 'AUTO' }),
    'TASK_DEADLINE_EXCEEDED',
  );
});
