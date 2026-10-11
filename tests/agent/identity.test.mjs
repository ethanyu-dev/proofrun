import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateChecks,
  mergeChecks,
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
