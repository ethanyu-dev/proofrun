import assert from 'node:assert/strict';
import test from 'node:test';
import type { VerificationTask } from '@proofrun/contracts';
import { sessionAuth } from '../src/modules/scheduling/auth.js';
import { task } from './fixture.js';
import {
  compileCase,
  expandCaseTasks,
} from '../src/modules/cases/structured.js';

// 范围：自动槽位按环境与站点稳定隔离、重跑换初始快照；不验证节点文件或真实登录。
test('自动登录复用在同站点重跑间稳定，显式退出不创建槽位', () => {
  const definition = task('auth-fixture') as VerificationTask;
  definition.environment.allowIntervention = true;
  definition.target.url = 'https://example.test/first';
  const first = sessionAuth(definition)!;
  assert.equal(first.restore, true);
  assert.equal(first.restoreIfPresent, true);
  const next = structuredClone(definition);
  next.taskId = 'another-task';
  next.target.url = 'https://example.test/second';
  assert.equal(sessionAuth(next)?.stateId, first.stateId);
  assert.notEqual(sessionAuth(next)?.snapshotId, first.snapshotId);
  next.target.url = 'https://other.test/first';
  assert.notEqual(sessionAuth(next)?.stateId, first.stateId);
  next.environment.reuseAuth = false;
  assert.equal(sessionAuth(next), null);
});

// 范围：并行两组固定同轮快照与命名槽位，显式恢复不忽略缺失；不验证调度或 Chromium。
test('命名登录状态允许两组读取同一初始快照', () => {
  const definition = task('auth-fixture') as VerificationTask;
  definition.environment.auth = {
    nodeId: 'node',
    stateId: 'account',
    restore: true,
  };
  const llm = {
    ...definition,
    taskId: 'pair-llm',
    comparison: { id: 'pair', arm: 'llm' as const, sourceTaskId: 'source' },
  };
  const jev = {
    ...llm,
    taskId: 'pair-jev',
    comparison: { ...llm.comparison, arm: 'jev' as const },
  };
  assert.deepEqual(sessionAuth(llm), sessionAuth(jev));
  assert.equal(sessionAuth(llm)?.restoreIfPresent, false);
  assert.equal(sessionAuth(llm)?.stateId, 'account');
});

/** v2 默认会话也经过真实编译入口，避免仅对手工拼出的内部任务验证开关。 */
function v2Task(
  caseId = 'auth-v2',
  executionMode?: VerificationTask['executionMode'],
) {
  return compileCase(
    {
      caseId,
      platform: '登录夹具',
      entry: 'https://example.test/referral',
      steps: [
        {
          type: 'verification',
          url: 'https://example.test/referral',
          exec_order: 1,
          description: '登录后查看页面',
          policy: [],
          expected: ['显示结果'],
        },
      ],
      cleanup: [],
    },
    {
      environment: { id: 'fixture', nodePool: 'fixture' },
      budget: { maxActions: 10 },
      ...(executionMode ? { executionMode } : {}),
      evidenceKinds: ['DOM'],
    },
  );
}

// 范围：默认单组、跨任务/旧版槽位复用、显式双跑快照与环境隔离；不读取真实 Cookie 文件。
test('v2 默认 manual 会话复用本站槽位，显式双跑共享初始快照', () => {
  const first = v2Task();
  assert.equal(first.executionMode, 'jev');
  assert.equal(expandCaseTasks(first).length, 1);
  const auth = sessionAuth(first)!;
  assert.equal(first.sessionPlan!.mode, 'manual');
  assert.equal(auth.restore, true);
  assert.equal(auth.restoreIfPresent, true);
  const { sessionPlan: _plan, ...legacy } = first;
  assert.equal(sessionAuth(legacy)!.stateId, auth.stateId);
  const second = v2Task('next');
  assert.equal(sessionAuth(second)!.stateId, auth.stateId);
  assert.notEqual(sessionAuth(second)!.snapshotId, auth.snapshotId);
  const arms = expandCaseTasks(v2Task('auth-pair', 'parallel'));
  assert.equal(arms.length, 2);
  assert.deepEqual(sessionAuth(arms[0]!), sessionAuth(arms[1]!));
  for (const change of [
    { target: { url: 'https://other.test' } },
    { environment: { ...first.environment, id: 'other' } },
    { environment: { ...first.environment, nodePool: 'other' } },
  ])
    assert.notEqual(
      sessionAuth({ ...first, ...change })!.stateId,
      auth.stateId,
    );
});

// 范围：访客、显式身份、显式登录槽和关闭复用的优先级，显式双跑隔离槽一致；不证明账号角色或实际登录有效。
test('v2 访客不恢复，指定账号不混用本站登录，关闭复用使用隔离槽', () => {
  const original = v2Task();
  const shared = sessionAuth(original)!;
  const isolated = structuredClone(original);
  isolated.environment.reuseAuth = false;
  assert.equal(sessionAuth(isolated)!.restore, false);
  assert.notEqual(sessionAuth(isolated)!.stateId, shared.stateId);
  assert.notEqual(
    sessionAuth({ ...isolated, taskId: 'other' })!.stateId,
    sessionAuth(isolated)!.stateId,
  );
  const parallel = v2Task('isolated-pair', 'parallel');
  parallel.environment.reuseAuth = false;
  const arms = expandCaseTasks(parallel);
  assert.equal(arms.length, 2);
  assert.deepEqual(sessionAuth(arms[0]!), sessionAuth(arms[1]!));
  for (const mode of ['identity', 'pool'] as const) {
    const selected = structuredClone(original);
    selected.sessionPlan!.mode = mode;
    selected.sessionPlan!.candidates = [
      {
        id: 'team',
        label: '团队账号',
        accountKey: 'team',
        origins: ['https://example.test'],
        checks: [],
        maxConcurrent: 1,
        stateId: 'team-state',
      },
    ];
    assert.equal(sessionAuth(selected)!.stateId, 'team-state');
    assert.equal(sessionAuth(selected)!.restore, true);
  }
  original.environment.auth = {
    nodeId: 'node',
    stateId: 'named',
    restore: true,
  };
  assert.equal(sessionAuth(original)!.stateId, 'named');
  assert.equal(sessionAuth(original)!.restoreIfPresent, false);
  original.sessionPlan!.mode = 'guest';
  assert.equal(sessionAuth(original), null);
});
