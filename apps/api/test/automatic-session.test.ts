import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateVerificationTask,
  validateVerificationCaseV2,
  type VerificationCaseV2,
} from '@proofrun/contracts';
import { compileCase } from '../src/modules/cases/structured.js';
import { ExternalAccounts } from '../src/modules/account-providers/service.js';
import type { Database } from '../src/db.js';
import type { DevPassConfig } from '../src/modules/account-providers/config.js';

/** 编译与路由夹具不访问密钥、账号服务或浏览器；租约闭环另由真实 MCP 集成测试验证。 */
const PROVIDER: DevPassConfig = {
  id: 'devpass',
  url: 'https://accounts.example.test/mcp',
  clientId: 'fixture',
  tokenFile: '/unused/token',
  privateKeyFiles: { fixture: '/unused/key' },
  maxDurationSeconds: 7200,
};
const PROFILE: import('../src/modules/cases/profile.js').CaseProfile = {
  environment: { id: 'fixture', nodePool: 'fixture' },
  budget: { maxActions: 20 },
  evidenceKinds: ['DOM' as const],
};
/** 只提供原始需求，不把 expected 中的身份文案当作取账号授权。 */
function input(description: string): VerificationCaseV2 {
  return {
    caseId: 'automatic',
    platform: 'example',
    entry: 'https://example.test/app',
    steps: [
      {
        type: 'setup',
        url: 'https://example.test/app',
        exec_order: 1,
        description,
        policy: [],
        expected: [],
      },
      {
        type: 'verification',
        url: 'https://example.test/app',
        exec_order: 2,
        description: '检查内容',
        policy: [],
        expected: ['显示已登录文案'],
      },
    ],
    cleanup: [],
  };
}

// 范围：明确访客、无登录要求及登录界面验收不取账号；不证明实际页面可匿名访问。
test('自动会话不会因标题式文案、登录按钮或 expected 获取账号', () => {
  const accounts = new ExternalAccounts({} as Database, PROVIDER);
  for (const description of [
    '保持未登录访客状态',
    '检查首页',
    '检查登录按钮',
    'verify the sign in page',
    '如果已登录则显示昵称',
    '无需登录',
  ]) {
    const task = compileCase(input(description), PROFILE);
    accounts.prepare(task);
    assert.equal(
      task.sessionPlan?.automatic?.loginRequired,
      false,
      description,
    );
    assert.equal(task.sessionPlan?.mode, 'guest', description);
    assert.equal(task.executionPlan?.environment.mode, 'guest', description);
    assert.equal(task.sessionPlan?.external, undefined, description);
    assert.ok(
      validateVerificationTask(task),
      JSON.stringify(validateVerificationTask.errors),
    );
  }
});

// 范围：按 case 平台与精确源查询，不要求前端提供账号池，也不把登录条件编造成页面文本检查。
test('需要登录时自动准备 DevPass 查询并保留原始步骤', () => {
  const original = input('使用测试账号登录后查看页面');
  const before = structuredClone(original);
  const task = compileCase(original, PROFILE);
  new ExternalAccounts({} as Database, PROVIDER).prepare(task);
  assert.equal(task.sessionPlan?.mode, 'external');
  assert.deepEqual(task.sessionPlan?.external?.selector, {
    provider: 'devpass',
    platform: 'example',
  });
  assert.equal(task.sessionPlan?.external?.origin, 'https://example.test');
  assert.ok(task.sessionPlan!.external!.durationSeconds > 60);
  assert.deepEqual(task.caseV2Definition, before);
  assert.deepEqual(original, before);
  assert.ok(
    validateVerificationTask(task),
    JSON.stringify(validateVerificationTask.errors),
  );
});

// 范围：未配置来源及预算不适合外部账号时要求人工确认，原角色条件不丢失；不验证真人登录。
test('自动身份无法使用 DevPass 时保留身份约束并转人工', () => {
  for (const config of [undefined, { ...PROVIDER, maxDurationSeconds: 60 }]) {
    const original = input('必须登录');
    original.session = {
      mode: 'auto',
      requirements: [
        {
          id: 'member',
          method: 'text',
          description: '测试成员',
          value: '测试成员',
        },
      ],
    };
    assert.ok(validateVerificationCaseV2(original));
    const task = compileCase(original, PROFILE);
    const accounts = new ExternalAccounts({} as Database, config);
    accounts.prepare(task);
    accounts.prepare(task);
    assert.equal(task.sessionPlan?.mode, 'manual');
    assert.equal(task.sessionPlan?.external, undefined);
    assert.ok(task.sessionPlan?.automatic?.fallbackReason);
    assert.equal(task.sessionPlan?.requirements.length, 2);
    assert.deepEqual(
      task.sessionPlan?.requirements[0],
      original.session.requirements![0],
    );
    assert.equal(task.sessionPlan?.requirements[1]?.method, 'manual');
    assert.ok(
      validateVerificationTask(task),
      JSON.stringify(validateVerificationTask.errors),
    );
  }
});

// 范围：显式访客和人工仍是调用方约束；自动模式可复用已知账号范围，不绕过原身份核验。
test('自动查询尊重显式身份约束与外部账号范围', () => {
  const accounts = new ExternalAccounts({} as Database, PROVIDER);
  for (const mode of ['guest', 'manual'] as const) {
    const original = input('检查首页');
    original.session = { mode };
    const task = compileCase(original, PROFILE);
    accounts.prepare(task);
    assert.equal(task.sessionPlan?.mode, mode);
    assert.equal(task.sessionPlan?.automatic, undefined);
  }
  const original = input('已登录');
  original.session = {
    mode: 'auto',
    external: {
      provider: 'devpass',
      platform: 'stable-platform',
      accountId: 'chosen-account',
    },
  };
  const task = compileCase(original, PROFILE);
  accounts.prepare(task);
  assert.deepEqual(
    task.sessionPlan?.external?.selector,
    original.session.external,
  );
});

// 范围：常见登录及角色要求、明确访客和冲突在编译时区分；不声称覆盖任意自然语言表达。
test('登录和账号身份前置条件统一判断，冲突不静默选择身份', () => {
  for (const text of [
    '登录系统',
    '账号必须为团队成员',
    '使用管理员身份',
    'must sign in',
  ]) {
    assert.equal(
      compileCase(input(text), PROFILE).sessionPlan?.automatic?.loginRequired,
      true,
      text,
    );
  }
  for (const text of ['确保未登录', '未登录状态访问首页']) {
    assert.equal(
      compileCase(input(text), PROFILE).sessionPlan?.mode,
      'guest',
      text,
    );
  }
  const conflicting = input('保持未登录');
  conflicting.steps[0]!.policy = ['账号必须为团队成员'];
  assert.throws(() => compileCase(conflicting, PROFILE), {
    code: 'ENVIRONMENT_CONFIG_CONFLICT',
  });
});

// 范围：人工确认条件不与业务条件同名，重复准备不追加条件；不模拟真实人工页面。
test('自动人工确认保留步骤条件且避免条件 ID 冲突', () => {
  const original = input('必须登录');
  original.steps[0]!.preconditions = [
    {
      id: 'automatic-login',
      method: 'text',
      description: '成员区域',
      value: '成员区域',
    },
  ];
  const task = compileCase(original, PROFILE);
  const accounts = new ExternalAccounts({} as Database);
  accounts.prepare(task);
  accounts.prepare(task);
  assert.equal(task.sessionPlan?.requirements.length, 1);
  assert.equal(task.sessionPlan?.requirements[0]?.id, 'automatic-login-1');
  assert.deepEqual(
    task.steps?.[0]?.preconditions,
    original.steps[0]!.preconditions,
  );
});
