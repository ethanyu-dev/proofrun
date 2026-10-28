import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateVerificationTask,
  validateVerificationCaseV2,
  taskEvidenceKinds,
  type VerificationCaseV2,
} from '@proofrun/contracts';
import { compileCase } from '../src/modules/cases/structured.js';

/** 只验证编译计划、协议和冲突，不代表浏览器已完成准备或生产站点验收。 */
const input = (): VerificationCaseV2 => ({
  caseId: 'environment-plan',
  platform: '夹具',
  entry: 'https://fixture.test',
  steps: [
    {
      stepId: 'setup',
      type: 'setup',
      url: 'https://fixture.test',
      exec_order: 1,
      description: '保持未登录访客状态',
      policy: ['活动接口返回成功'],
      expected: [],
    },
    {
      stepId: 'verify',
      type: 'verification',
      url: 'https://fixture.test',
      exec_order: 2,
      description: '检查结果',
      policy: [],
      expected: ['显示业务结果'],
    },
  ],
  cleanup: [],
});
const profile: import('../src/modules/cases/profile.js').CaseProfile = {
  environment: { id: 'fixture', nodePool: 'fixture', reuseAuth: true },
  budget: { timeoutMs: 10000, maxActions: 20 },
  evidenceKinds: ['DOM' as const],
};

// 范围：会话创建前推导明确访客，保留原定义；不依据页面登录按钮判断实际身份。
test('明确访客需求冻结为 guest，显式冲突提前拒绝', () => {
  const original = input();
  const task = compileCase(original, profile);
  assert.equal(task.sessionPlan?.mode, 'guest');
  assert.equal(task.executionPlan?.environment.source, 'inferred');
  assert.deepEqual(task.caseV2Definition, original);
  assert.equal(original.session, undefined);
  assert(
    validateVerificationTask(task),
    JSON.stringify(validateVerificationTask.errors),
  );
  assert.throws(
    () => compileCase({ ...original, session: { mode: 'manual' } }, profile),
    { code: 'ENVIRONMENT_CONFIG_CONFLICT' },
  );
  assert.equal(
    compileCase({ ...original, session: { mode: 'guest' } }, profile)
      .executionPlan?.environment.source,
    'explicit',
  );
});

// 范围：否定、引用、条件及 expected 不参与自动身份选择；不声称覆盖所有自然语言语法。
test('歧义文本保留节点模板默认来源，不推断访客要求', () => {
  for (const text of [
    '如果未登录则提示登录',
    '不要退出登录',
    '示例：保持未登录',
    '显示“保持未登录”按钮',
  ]) {
    const original = input();
    original.steps[0]!.description = text;
    original.steps[0]!.expected = ['保持未登录访客状态'];
    assert.equal(compileCase(original, profile).sessionPlan?.mode, 'manual');
    assert.equal(
      compileCase(original, profile).sessionPlan?.profileSource,
      'node-default',
    );
  }
});

// 范围：setup 和 cleanup 的直接接口检查增加采集能力且不增加业务 expected；不验证接口实际返回。
test('固定检查绑定 policy 并冻结全流程证据并集', () => {
  const original = input();
  original.steps[0]!.policyChecks = [
    {
      id: 'activity',
      description: '活动接口响应',
      policyIndex: 0,
      method: 'networkResponse',
      path: '/v1/activity/invite-activity-info',
      statusMin: 200,
      statusMax: 299,
    },
  ];
  original.cleanup = [
    {
      url: original.entry,
      exec_order: 1,
      description: '检查清理状态',
      policy: ['清理成功'],
      policyChecks: [
        {
          id: 'cleanup-response',
          description: '清理响应',
          policyIndex: 0,
          method: 'networkResponse',
          path: '/cleanup',
          statusMin: 200,
          statusMax: 200,
        },
      ],
    },
  ];
  assert(
    validateVerificationCaseV2(original),
    JSON.stringify(validateVerificationCaseV2.errors),
  );
  const task = compileCase(original, profile);
  assert.deepEqual(taskEvidenceKinds(task), ['DOM', 'NETWORK']);
  assert.equal(task.acceptanceCriteria.length, 1);
  assert.equal(task.steps?.at(-1)?.policyChecks?.[0]?.id, 'cleanup-response');
  original.steps[0]!.policyChecks![0]!.policyIndex = 1;
  assert.throws(() => compileCase(original, profile), {
    code: 'INVALID_POLICY_CHECK',
  });
  original.steps[0]!.policyChecks![0]!.policyIndex = 0;
  original.steps[0]!.policyChecks![0]!.statusMax = 100;
  assert.throws(() => compileCase(original, profile), {
    code: 'INVALID_POLICY_CHECK',
  });
  delete original.steps[0]!.policyChecks![0]!.path;
  assert.equal(validateVerificationCaseV2(original), false);
});

// 范围：能力只影响准入与证据需求，不新增业务标准，也不把登录与运行时能力混同。
test('PWA 和响应头检查在准入前声明实际证据能力', () => {
  const original = input();
  original.steps[1]!.description =
    '检查 Service Worker 与 CacheStorage，响应头 Cache-Control';
  original.steps[1]!.expected = ['Service Worker 已激活'];
  const task = compileCase(original, profile);
  assert.deepEqual(task.executionPlan?.requiredCapabilities, [
    'runtimeEvidenceV1',
    'networkDetailsV1',
  ]);
  assert.deepEqual(taskEvidenceKinds(task), ['DOM', 'RUNTIME', 'NETWORK']);
  assert.deepEqual(task.acceptanceCriteria[0]!.evidenceKinds, [
    'DOM',
    'RUNTIME',
    'NETWORK',
  ]);
  assert.equal(task.sessionPlan?.mode, 'guest');
  assert(
    validateVerificationTask(task),
    JSON.stringify(validateVerificationTask.errors),
  );
});
