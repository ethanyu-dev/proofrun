import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateCaseProfile,
  type CaseProfile,
} from '../src/modules/cases/profile.js';

/** 仅校验平台配置，不连接数据库、节点或模型。 */
const PROFILE: CaseProfile = {
  environment: {
    id: 'private-environment',
    nodePool: 'private-pool',
    auth: { nodeId: 'private-node', stateId: 'private-login', restore: true },
  },
  budget: { timeoutMs: 60000, maxActions: 20 },
  executionMode: 'llm',
  evidenceKinds: ['DOM'],
};

// 范围：服务端配置拒绝旧默认地址、无效模式和超限预算；不证明节点、账号或站点真实可用。
test('case 平台配置校验环境、模式和预算', () => {
  assert.deepEqual(validateCaseProfile(PROFILE), PROFILE);
  for (const invalid of [
    null,
    {},
    { ...PROFILE, executionMode: 'unknown' },
    { ...PROFILE, budget: { timeoutMs: 86400001, maxActions: 20 } },
    { ...PROFILE, evidenceKinds: [] },
    { ...PROFILE, target: { url: 'https://old-default.example.test' } },
    { ...PROFILE, unexpected: true },
  ]) {
    assert.throws(() => validateCaseProfile(invalid));
  }
});
