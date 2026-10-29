import { identityPlacement } from '../src/modules/scheduling/placement.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { VerificationTask } from '@proofrun/contracts';
import { task } from './fixture.js';
import {
  compileCase,
  assertCaseExecution,
} from '../src/modules/cases/structured.js';
import {
  validateCaseProfile,
  type CaseProfile,
} from '../src/modules/cases/profile.js';

/** 只验证会话编译与旧协议退役，不读取真实身份材料或启动浏览器。 */
const profile: CaseProfile = {
  environment: { id: 'fixture', nodePool: 'fixture' },
  budget: { maxActions: 10 },
  evidenceKinds: ['DOM' as const],
};
// 范围：旧槽位配置不能重新激活保存/恢复链路；不验证真实 Cookie 有效性。
test('身份路由只遵循显式节点，不因 reuseAuth 创建自动偏好', () => {
  const original = task('ephemeral') as VerificationTask;
  assert.deepEqual(identityPlacement(original, undefined), {
    requiredNode: undefined,
  });
  for (const reuseAuth of [true, false]) {
    original.environment.reuseAuth = reuseAuth;
    original.environment.auth = {
      nodeId: 'legacy-node',
      stateId: 'legacy-state',
      restore: true,
    };
    assert.equal(
      identityPlacement(original, 'different-node').conflict,
      'AUTH_NODE_ROUTE_CONFLICT',
    );
  }
});
// 范围：新提交只有单一 LLM 且不放大模型额度；历史报告读取另由数据库夹具覆盖。
test('默认 LLM 单组，明确拒绝 JEV 与 parallel 新任务', () => {
  const compiled = compileCase(
    {
      caseId: 'ephemeral',
      platform: 'fixture',
      entry: 'https://example.test',
      steps: [
        {
          type: 'verification',
          url: 'https://example.test',
          exec_order: 1,
          description: '检查页面',
          policy: [],
          expected: ['显示结果'],
        },
      ],
      cleanup: [],
    },
    profile,
  );
  assert.equal(compiled.executionMode, 'llm');
  assert.equal(currentTasks(compiled).length, 1);
  for (const executionMode of ['jev', 'parallel'] as const) {
    assert.throws(() =>
      validateCaseProfile({
        ...profile,
        executionMode: executionMode as never,
      }),
    );
    assert.throws(
      () =>
        currentTasks({ ...compiled, executionMode: executionMode as never }),
      {
        code: 'EXECUTION_MODE_RETIRED',
      },
    );
  }
});

/** 为旧批量夹具包装当前准入结果；不构造双跑或清理执行。 */
function currentTasks(task: import('@proofrun/contracts').VerificationTask) {
  assertCaseExecution(task);
  return [task];
}
