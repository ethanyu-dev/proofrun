import test from 'node:test';
import assert from 'node:assert/strict';
import { guidanceSummary } from '../../apps/console/src/components/execution-guidance';

// 范围：两种实际请求格式的诊断展示与旧记录兼容；不验证浏览器布局或模型判断。
test('消息与结构化上下文展示相同的计划诊断，旧记录不补造', () => {
  const context = {
    executionGuidance: {
      version: 'goal-progress-v1',
      review: 'STATE_CYCLE',
      currentPlan: {
        id: 'p1',
        goal: '核对剩余要求',
        phase: 'collect',
        remaining: 2,
      },
      budget: { estimatedActions: 3 },
    },
  };
  const structured = guidanceSummary({ state: context });
  const llm = guidanceSummary({
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: JSON.stringify(context) }],
      },
    ],
  });
  assert.deepEqual(structured, llm);
  assert.equal(structured?.review, '重复返回已访问状态');
  assert.equal(structured?.goal, '核对剩余要求');
  assert.equal(guidanceSummary({}), null);
});
