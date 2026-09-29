import assert from 'node:assert/strict';
import test from 'node:test';
import type { VerificationTask } from '@proofrun/contracts';
import { sessionAuth } from '../src/modules/scheduling/auth.js';
import { task } from './fixture.js';

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
