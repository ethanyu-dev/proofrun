import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateVerificationCaseV2,
  type VerificationCaseV2,
  type SessionPlan,
  type SessionRequest,
} from '@proofrun/contracts';
import {
  resolveSession,
  assertSupportedSession,
} from '../src/modules/sessions/plan.js';
import type { CaseProfile } from '../src/modules/cases/profile.js';
import { compileCase } from '../src/modules/cases/structured.js';

/** 仅用业务定义夹具验证编译与协议，未连接真实账号或浏览器。 */
const INPUT: VerificationCaseV2 = {
  caseId: 'session-fixture',
  platform: '夹具',
  entry: 'https://example.test',
  steps: [
    {
      type: 'verification' as const,
      url: 'https://example.test',
      exec_order: 1,
      description: '检查页面',
      policy: [],
      expected: ['显示内容'],
    },
  ],
  cleanup: [],
};
const PROFILE: CaseProfile = {
  environment: { id: 'fixture', nodePool: 'fixture' },
  budget: { timeoutMs: 10000, maxActions: 20 },
  evidenceKinds: ['DOM' as const],
};

// 范围：省略会话不再等待选账号，访客和人工条件保持明确；不证明站点实际登录状态。
test('默认会话直接编译且不产生本地候选或身份选择', () => {
  for (const session of [
    undefined,
    { mode: 'guest' as const },
    { mode: 'manual' as const },
  ]) {
    const task = compileCase(
      { ...INPUT, ...(session ? { session } : {}) },
      PROFILE,
    );
    assert.equal(task.sessionPlan?.mode, session?.mode ?? 'manual');
    assert.equal(
      task.sessionPlan?.profileSource,
      session?.mode === 'guest' ? 'empty' : 'node-default',
    );
    assert.equal(task.sessionPlan?.reducedMotion, true);
    assert.deepEqual(task.sessionPlan?.candidates, []);
    assert.equal(task.sessionPlan?.selection, undefined);
    assert.equal(task.sessionPlan?.library, undefined);
    assert.doesNotThrow(() => assertSupportedSession(task.sessionPlan));
  }
});

// 范围：提交协议与重跑的编译入口均拒绝旧账号来源；不验证数据库迁移或历史报告渲染。
test('旧本地身份和账号池不能静默退回访客', () => {
  for (const mode of ['identity', 'pool', 'auto']) {
    const session = { mode, identityRef: 'old', poolRef: 'old' };
    assert.equal(validateVerificationCaseV2({ ...INPUT, session }), false);
    assert.throws(
      () => resolveSession(session as unknown as SessionRequest, INPUT.entry),
      { code: 'LOCAL_IDENTITY_REMOVED' },
    );
  }
  const base = resolveSession({ mode: 'manual' }, INPUT.entry);
  for (const patch of [
    { mode: 'identity' },
    { library: true },
    { selection: 'pending' },
    { candidates: [{}] },
  ])
    assert.throws(
      () => assertSupportedSession({ ...base, ...patch } as SessionPlan),
      { code: 'LOCAL_IDENTITY_REMOVED' },
    );
});

// 范围：DevPass 选择条件保留且不携带材料；真实租约获取、关闭和交还由 external-accounts 集成夹具覆盖。
test('DevPass 是唯一自动账号来源，必须给出核验条件', () => {
  const session: SessionRequest = {
    mode: 'external',
    external: { provider: 'devpass', platform: 'fixture', poolId: 'members' },
    requirements: [
      { id: 'member', description: '会员身份', method: 'text', value: '会员' },
    ],
  };
  assert.equal(validateVerificationCaseV2({ ...INPUT, session }), true);
  const task = compileCase({ ...INPUT, session }, PROFILE);
  assert.deepEqual(task.sessionPlan?.external?.selector, session.external);
  assert.deepEqual(task.sessionPlan?.requirements, session.requirements);
  assert.equal(task.sessionPlan?.external?.origin, INPUT.entry);
  assert.deepEqual(task.sessionPlan?.candidates, []);
  assert.throws(
    () => resolveSession({ ...session, requirements: [] }, INPUT.entry),
    { code: 'EXTERNAL_ACCOUNT_REQUIREMENTS' },
  );
});

// 范围：自动与显式身份共用动画偏好默认值和布尔契约；不验证真实媒体查询。
test('动画偏好可独立于身份显式关闭且不修改输入', () => {
  for (const mode of ['auto', 'guest', 'manual'] as const) {
    const input = { ...INPUT, session: { mode, reducedMotion: false } };
    const before = structuredClone(input);
    assert.equal(validateVerificationCaseV2(input), true);
    assert.equal(compileCase(input, PROFILE).sessionPlan?.reducedMotion, false);
    assert.deepEqual(input, before);
  }
  assert.equal(
    validateVerificationCaseV2({
      ...INPUT,
      session: { mode: 'auto', reducedMotion: 'false' },
    }),
    false,
  );
});
