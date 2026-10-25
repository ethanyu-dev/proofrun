import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateChecks,
  mergeChecks,
  sessionIdentityFacts,
} from '../../apps/agent/dist/execution/identity.js';

/** 本地观察夹具只验证前置门禁，不证明真实网页权限或账号绑定状态。 */
const page = {
  text: '测试账号 个人',
  targets: [],
  artifactRefs: [{ artifactId: 'dom-fixture' }],
  truncated: false,
};
// 范围：个人显示名不能满足团队条件，引用证据不等于条件已满足。
test('身份条件不接受个人角色代替团队成员', () => {
  const result = evaluateChecks(
    [
      {
        id: 'team',
        description: '当前测试团队',
        method: 'text',
        value: '测试团队',
      },
    ],
    page,
    new Map(),
    0,
  );
  assert.equal(result[0].status, 'UNSATISFIED');
  assert.deepEqual(result[0].evidenceRefs, ['dom-fixture']);
});

/** 仅模拟已保存的准备结果，不模拟真实登录或把账号文案当成认证凭证。 */
function preparation(overrides = {}) {
  return {
    stepId: 'setup',
    status: 'COMPLETED',
    preconditions: [
      {
        id: 'login',
        description: '人工确认当前账号',
        source: 'human',
        status: 'SATISFIED',
        controlRevision: 2,
        authRevision: 1,
        evidenceRefs: [],
        ...overrides,
      },
    ],
  };
}

// 范围：同执行准备事实按认证版本传递，旧协议按控制代次；不证明真实页面仍处于登录状态。
test('准备人工确认跨业务步骤保留，认证变化后失效', () => {
  const setup = preparation();
  assert.equal(sessionIdentityFacts([setup], [], 4, 1).length, 1);
  assert.deepEqual(sessionIdentityFacts([setup], [], 4, 2), []);
  assert.equal(sessionIdentityFacts([setup], [], 2).length, 1);
  assert.deepEqual(sessionIdentityFacts([setup], [], 4), []);
  const copy = sessionIdentityFacts([setup], [], 2, 1);
  copy[0].status = 'UNCONFIRMED';
  assert.equal(setup.preconditions[0].status, 'SATISFIED');
});

// 范围：当前条件和最新准备结果可否定历史，旧观察与未完成阶段不传递；不自动修改门禁结果。
test('会话事实不能覆盖当前缺失条件或复活已撤销确认', () => {
  const setup = preparation();
  assert.deepEqual(
    sessionIdentityFacts(
      [setup],
      [{ id: 'login', status: 'UNSATISFIED' }],
      2,
      1,
    ),
    [],
  );
  for (const override of [
    { source: 'observation' },
    { source: 'platform' },
    { status: 'UNCONFIRMED' },
    { authRevision: undefined },
  ])
    assert.deepEqual(
      sessionIdentityFacts([preparation(override)], [], 2, 1),
      [],
    );
  assert.deepEqual(
    sessionIdentityFacts([{ ...setup, status: 'BLOCKED' }], [], 2, 1),
    [],
  );
  assert.deepEqual(
    sessionIdentityFacts([setup, { ...setup, status: 'BLOCKED' }], [], 2, 1),
    [],
  );
  assert.deepEqual(
    sessionIdentityFacts(
      [setup, preparation({ status: 'UNCONFIRMED' })],
      [],
      2,
      1,
    ),
    [],
  );
});
// 范围：人工声明绑定控制代次，裁剪证据不能证明元素缺失；不模拟真实 HITL 页面。
test('人工确认不能跨控制代次复用，缺失观察不证明不存在', () => {
  const checks = [
    { id: 'role', description: '非团队所有者', method: 'manual' },
  ];
  assert.equal(
    evaluateChecks(checks, page, new Map([['role', 2]]), 2)[0].status,
    'SATISFIED',
  );
  assert.equal(
    evaluateChecks(checks, page, new Map([['role', 2]]), 4)[0].status,
    'UNCONFIRMED',
  );
  assert.equal(
    evaluateChecks(
      [
        {
          id: 'absent',
          description: '未绑定',
          method: 'absent',
          value: '已绑定',
        },
      ],
      { ...page, truncated: true },
      new Map(),
      0,
    )[0].status,
    'UNCONFIRMED',
  );
  assert.throws(
    () => mergeChecks(checks, [{ ...checks[0], description: '另一角色' }]),
    /冲突/,
  );
});

// 范围：版本混用时拒绝旧本地身份计划，避免丢失账号约束后继续执行；不启动浏览器或调用真实账号来源。
test('旧本地身份计划不能在新 Agent 上降级执行', async () => {
  const { executionStrategy } =
    await import('../../apps/agent/dist/model/strategy.js');
  const base = {
    version: 1,
    mode: 'manual',
    candidates: [],
    requirements: [],
    preparationMs: 120000,
  };
  for (const patch of [
    { mode: 'identity' },
    { mode: 'pool' },
    { library: true },
    { selection: 'pending' },
    { candidates: [{}] },
  ])
    assert.throws(
      () => executionStrategy({ sessionPlan: { ...base, ...patch } }),
      { code: 'LOCAL_IDENTITY_REMOVED' },
    );
  assert.equal(executionStrategy({ sessionPlan: base }), 'llm');
});
