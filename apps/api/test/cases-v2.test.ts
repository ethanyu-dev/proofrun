import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateVerificationCaseV2,
  validateVerificationTask,
  validateCaseResultV2,
  type VerificationCaseV2,
  type VerificationTask,
} from '@proofrun/contracts';
import { compileCase, cleanupTask } from '../src/modules/cases/structured.js';
import { CaseV2Service } from '../src/modules/cases/v2.js';
import type { CaseProfile } from '../src/modules/cases/profile.js';
import type { Coordinator } from '../src/modules/scheduling/coordinator.js';
import { ApiError, canonical } from '../src/domain.js';

/** 平台与业务夹具只验证协议映射，不连接真实业务或模型。 */
const PROFILE: CaseProfile = {
  environment: { id: 'fixture', nodePool: 'fixture' },
  budget: { timeoutMs: 10000, maxActions: 20 },
  executionMode: 'llm',
  evidenceKinds: ['DOM'],
};
const INPUT: VerificationCaseV2 = {
  caseId: 'case-1',
  platform: '测试站点',
  entry: 'https://example.test',
  steps: [
    {
      type: 'verification',
      url: 'https://example.test/result',
      exec_order: 5,
      description: '检查结果',
      policy: [],
      expected: ['显示结果'],
    },
    {
      type: 'setup',
      url: 'https://example.test/settings',
      exec_order: 1,
      description: '填写整数',
      policy: ['500～10000 的整数'],
      expected: [],
    },
    {
      type: 'verification',
      url: 'https://example.test/result',
      exec_order: 5,
      description: '检查另一结果',
      policy: [],
      expected: ['显示另一结果'],
    },
  ],
  cleanup: [
    {
      url: 'https://example.test/settings',
      exec_order: 1,
      description: '恢复为明确指定的测试值',
    },
  ],
};

/** 只模拟原子任务端口，事务隔离和并发由 PostgreSQL 集成测试检查。 */
function fixture() {
  const records = new Map<string, Awaited<ReturnType<Coordinator['task']>>>();
  let batches = 0;
  const tasks: Pick<
    Coordinator,
    'submitCaseBatch' | 'task' | 'cancel' | 'caseCleanup'
  > = {
    async submitCaseBatch(definitions) {
      for (const d of definitions)
        if (
          records.has(d.taskId) &&
          canonical(records.get(d.taskId)!.definition.caseV2Definition) !==
            canonical(d.caseV2Definition)
        )
          throw new ApiError(409, 'CASE_CONFLICT', '冲突');
      batches++;
      for (const d of definitions)
        if (!records.has(d.taskId))
          records.set(d.taskId, {
            definition: d,
            state: 'QUEUED',
            report: null,
            executions: [],
          });
    },
    async task(id) {
      const record = records.get(id);
      if (!record) throw new ApiError(404, 'TASK_MISSING', '不存在');
      return record;
    },
    async cancel(id) {
      const record = await this.task(id);
      record.state = 'CANCELLED';
      return record;
    },
    async caseCleanup(id) {
      const cleanup = cleanupTask((await this.task(id)).definition);
      return cleanup
        ? { taskId: cleanup.taskId, status: 'PENDING', report: null }
        : null;
    },
  };
  return {
    records,
    tasks,
    service: new CaseV2Service(tasks, PROFILE, 'https://proofrun.test'),
    batches: () => batches,
  };
}

// 范围：乱序与同序稳定排序、原文约束、标准身份和独立清理定义；不验证页面输入效果。
test('v2 结构化编译保持步骤身份和标准归属', () => {
  assert(validateVerificationCaseV2(INPUT));
  const task = compileCase(INPUT, PROFILE);
  assert(
    validateVerificationTask(task),
    JSON.stringify(validateVerificationTask.errors),
  );
  assert.deepEqual(
    task.steps!.map((s) => s.stepId),
    ['step-2', 'step-1', 'step-3'],
  );
  assert.deepEqual(task.steps![0]!.policy, ['500～10000 的整数']);
  assert.deepEqual(
    task.acceptanceCriteria.map((c) => c.stepId),
    ['step-1', 'step-3'],
  );
  assert.deepEqual(task.caseV2Definition, INPUT);
  const cleanup = cleanupTask(task)!;
  assert(
    validateVerificationTask(cleanup),
    JSON.stringify(validateVerificationTask.errors),
  );
  assert.equal(cleanup.purpose, 'cleanup');
  assert.equal(cleanup.parentTaskId, task.taskId);
  assert.deepEqual(cleanup.acceptanceCriteria, []);
  assert.equal(cleanup.resourceKey, task.resourceKey);
  assert.notEqual(
    compileCase({ ...INPUT, entry: 'https://other.test' }, PROFILE).resourceKey,
    task.resourceKey,
  );
});

// 范围：协议拒绝非法类型、空验证标准、重复身份与预算不足；不判断自然语言约束能否被模型理解。
test('v2 在接收前拒绝不完整的执行定义', async () => {
  const { service, records } = fixture();
  for (const patch of [
    { type: 'cleanup' },
    { expected: [] },
    { exec_order: 0 },
    { url: 'file:///tmp/data' },
  ]) {
    await assert.rejects(
      service.submit([{ ...INPUT, steps: [{ ...INPUT.steps[0], ...patch }] }]),
      { code: 'INVALID_CASE' },
    );
  }
  await assert.rejects(
    service.submit([
      { ...INPUT, steps: INPUT.steps.map((s) => ({ ...s, stepId: 'same' })) },
    ]),
    { code: 'INVALID_CASE' },
  );
  await assert.rejects(
    service.submit([
      { ...INPUT, steps: [{ ...INPUT.steps[0], wait: { durationMs: 10000 } }] },
    ]),
    { code: 'WAIT_EXCEEDS_BUDGET' },
  );
  assert.equal(records.size, 0);
});

// 范围：批量幂等、快照冻结、冲突时整批不调用写端口；不模拟真实事务锁。
test('v2 批量校验和重提复用首次快照', async () => {
  const { service, records, tasks, batches } = fixture();
  const results = await service.submit([INPUT]);
  assert(
    validateCaseResultV2(results[0]),
    JSON.stringify(validateCaseResultV2.errors),
  );
  assert.equal(results[0]!.cleanup!.status, 'PENDING');
  const disabled = new CaseV2Service(tasks, undefined, 'https://proofrun.test');
  await disabled.submit([INPUT]);
  assert.equal(records.size, 1);
  const before = batches();
  await assert.rejects(
    service.submit([
      { ...INPUT, caseId: 'new' },
      { ...INPUT, platform: '改变定义' },
    ]),
    { code: 'CASE_CONFLICT' },
  );
  assert.equal(batches(), before);
  assert.equal(records.size, 1);
  await assert.rejects(service.submit([INPUT, INPUT]), {
    code: 'INVALID_CASE',
  });
  assert.equal((await service.cancel(INPUT.caseId)).status, 'CANCELLED');
});
