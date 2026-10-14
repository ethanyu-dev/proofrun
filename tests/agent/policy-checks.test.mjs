import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluatePolicyChecks,
  conditionKey,
} from '../../apps/agent/dist/execution/policy-checks.js';
import { evaluateChecks } from '../../apps/agent/dist/execution/identity.js';
import { EnvironmentHandoffs } from '../../apps/agent/dist/execution/environment-handoff.js';

/** 记录为合成夹具，只测试范围、证据与状态分类，不证明真实网络采集或业务成功。 */
const step = {
  stepId: 'setup',
  url: 'https://fixture.test/page',
  policyChecks: [
    {
      id: 'response',
      description: '接口成功',
      policyIndex: 0,
      method: 'networkResponse',
      path: '/api',
      statusMin: 200,
      statusMax: 299,
    },
  ],
};
const observation = (network) => ({
  url: step.url,
  text: '已渲染',
  artifactRefs: [{ kind: 'NETWORK', artifactId: 'network' }],
  ...(network ? { network } : {}),
});
const network = (status = 200) => ({
  scope: 'tab-navigation',
  navigationId: 'current',
  requests: [
    { url: 'https://fixture.test/api', status, navigationId: 'current' },
  ],
});

// 范围：必须为本次导航同源路径响应；没有记录与明确错误状态严格区分。
test('接口检查不接受渲染结果、旧导航或其他站点作为证明', () => {
  assert.equal(
    evaluatePolicyChecks(step, observation())[0].reason,
    'EVIDENCE_NOT_COLLECTED',
  );
  assert.equal(
    evaluatePolicyChecks(step, observation({ requests: [] }))[0].reason,
    'EVIDENCE_SCOPE_UNAVAILABLE',
  );
  const data = network();
  data.requests[0].navigationId = 'old';
  assert.equal(
    evaluatePolicyChecks(step, observation(data))[0].status,
    'UNCONFIRMED',
  );
  data.requests[0].navigationId = 'current';
  data.requests[0].url = 'https://other.test/api';
  assert.equal(
    evaluatePolicyChecks(step, observation(data))[0].status,
    'UNCONFIRMED',
  );
  assert.equal(
    evaluatePolicyChecks(step, observation(network(500)))[0].status,
    'UNSATISFIED',
  );
  assert.equal(
    evaluatePolicyChecks(step, observation(network()))[0].status,
    'SATISFIED',
  );
  assert.equal(
    evaluatePolicyChecks(step, {
      ...observation(network()),
      artifactRefs: [],
    })[0].status,
    'UNCONFIRMED',
  );
});

// 范围：稳定键不受 JSON 属性顺序影响，定义改变及认证变更撤销复用；不校验人工声明真实性。
test('确认绑定稳定定义和认证版本而非控制版本', () => {
  assert.equal(
    conditionKey('s', { a: 1, b: 2 }),
    conditionKey('s', { b: 2, a: 1 }),
  );
  assert.notEqual(conditionKey('s', { a: 1 }), conditionKey('s', { a: 2 }));
  const check = { id: 'guest', method: 'manual', description: '未登录' };
  assert.equal(
    evaluateChecks([check], observation(), new Map([['guest', 1]]), 8, 1)[0]
      .status,
    'SATISFIED',
  );
  assert.equal(
    evaluateChecks([check], observation(), new Map([['guest', 1]]), 8, 2)[0]
      .status,
    'UNCONFIRMED',
  );
  assert.equal(
    evaluateChecks([check], observation(), new Map([['guest', 1]]), 8)[0]
      .status,
    'UNCONFIRMED',
  );
});

// 范围：同版本去重、变更后重新确认和总上限；模拟回滚不表示真实控制面竞态已验收。
test('交接去重含认证版本且总共最多三轮', () => {
  const handoffs = new EnvironmentHandoffs();
  const conditions = [
    {
      id: 'guest',
      description: '未登录',
      summary: '待确认',
      status: 'UNCONFIRMED',
    },
  ];
  assert.equal(handoffs.claim('s', conditions, 0).length, 1);
  assert.equal(handoffs.claim('s', conditions, 0).length, 0);
  assert.equal(handoffs.claim('s', conditions, 1).length, 1);
  handoffs.release('s', conditions, 1);
  assert.equal(handoffs.claim('s', conditions, 1).length, 1);
  assert.equal(handoffs.claim('s', conditions, 2).length, 1);
  assert.equal(handoffs.claim('s', conditions, 3).length, 0);
});
