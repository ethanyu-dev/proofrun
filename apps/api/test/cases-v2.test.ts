import { inlineCleanup } from '../src/modules/cases/inline-cleanup.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateVerificationCaseV2,
  validateVerificationTask,
  validateCaseResultV2,
  type VerificationCaseV2,
  type VerificationTask,
} from '@proofrun/contracts';
import {
  compileCase,
  cleanupTask,
  expandCaseTasks,
} from '../src/modules/cases/structured.js';
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
function fixture(profile: CaseProfile = PROFILE) {
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
      for (const definition of definitions) {
        if (records.has(definition.taskId)) continue;
        for (const d of expandCaseTasks(definition))
          records.set(d.taskId, {
            definition: d,
            state: 'QUEUED',
            report: null,
            reportStatus: null,
            criteriaCounts: null,
            executions: [],
          });
      }
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
      const parent = await this.task(id);
      if (parent.definition.cleanupStepIds !== undefined)
        return inlineCleanup(parent);
      const cleanup = cleanupTask(parent.definition);
      return cleanup
        ? { taskId: cleanup.taskId, status: 'PENDING', report: null }
        : null;
    },
  };
  return {
    records,
    tasks,
    service: new CaseV2Service(tasks, profile, 'https://proofrun.test'),
    batches: () => batches,
  };
}

// 范围：乱序与同序稳定排序、原文约束、标准身份和同任务收尾定义；不验证页面输入效果。
test('v2 结构化编译保持步骤身份和标准归属', () => {
  assert(validateVerificationCaseV2(INPUT));
  const task = compileCase(INPUT, PROFILE);
  assert(
    validateVerificationTask(task),
    JSON.stringify(validateVerificationTask.errors),
  );
  assert.deepEqual(
    task.steps!.map((s) => s.stepId),
    ['step-2', 'step-1', 'step-3', 'cleanup-1'],
  );
  assert.deepEqual(task.steps![0]!.policy, ['500～10000 的整数']);
  assert.deepEqual(
    task.acceptanceCriteria.map((c) => c.stepId),
    ['step-1', 'step-3'],
  );
  assert.deepEqual(task.caseV2Definition, INPUT);
  assert.equal(cleanupTask(task), null);
  assert.deepEqual(task.cleanupStepIds, ['cleanup-1']);
  assert.equal(task.steps!.at(-1)!.type, 'setup');
  assert.notEqual(
    compileCase({ ...INPUT, entry: 'https://other.test' }, PROFILE).resourceKey,
    task.resourceKey,
  );
});

// 范围：新 case 身份隔离、同身份编译稳定及同任务清理标记；不验证数据库调度或真实登录态。
test('v2 互斥范围包含任务身份，新任务不继承历史清理阻塞', () => {
  const first = compileCase(INPUT, PROFILE);
  const second = compileCase({ ...INPUT, caseId: 'case-2' }, PROFILE);
  assert.equal(compileCase(INPUT, PROFILE).resourceKey, first.resourceKey);
  assert.notEqual(second.resourceKey, first.resourceKey);
  assert.equal(cleanupTask(first), null);
  assert.equal(cleanupTask(second), null);
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

// 范围：v2 部分失败后阻塞仍返回未通过和未覆盖数量；夹具不证明浏览器或真实产品的验收结果。
test('v2 报告状态保留局部失败而不被执行阻塞覆盖', async () => {
  const { service, records } = fixture();
  const queued = (await service.submit([INPUT]))[0]!;
  assert.equal(queued.reportStatus, null);
  const record = [...records.values()][0]!;
  record.state = 'COMPLETED';
  record.report = {
    protocolVersion: '0.1',
    taskId: record.definition.taskId,
    lifecycle: 'COMPLETED',
    executionDisposition: 'BLOCKED',
    verdict: null,
    summary: '部分验收后环境阻塞',
    criteria: [
      {
        criterionId: record.definition.acceptanceCriteria[0]!.id,
        verdict: 'FAILED',
        summary: '夹具明确失败',
        evidenceRefs: ['fixture-evidence'],
      },
    ],
    artifacts: [],
  };
  const result = await service.get(INPUT.caseId);
  assert(
    validateCaseResultV2(result),
    JSON.stringify(validateCaseResultV2.errors),
  );
  assert.equal(result.reportStatus, 'FAILED');
  assert.deepEqual(result.criteriaCounts, {
    total: 2,
    passed: 0,
    failed: 1,
    inconclusive: 0,
    skipped: 1,
  });
  assert.equal(result.result?.outcome, 'BLOCKED');
  assert.equal((await service.cancel(INPUT.caseId)).reportStatus, 'FAILED');
});

// 范围：v2 查询和幂等提交保留调度诊断，不伪造步骤结论；任务存档为夹具，不覆盖数据库或节点执行。
test('v2 返回排队原因并在超时后保留', async () => {
  const { service, records } = fixture();
  await service.submit([INPUT]);
  const record = records.get(`case-v2-${INPUT.caseId}`)!;
  record.queueReason = {
    code: 'NODE_CAPACITY',
    message: '符合条件的节点容量已满。',
  };
  for (const state of ['QUEUED', 'TIMED_OUT'] as const) {
    record.state = state;
    const result = await service.get(INPUT.caseId);
    assert(
      validateCaseResultV2(result),
      JSON.stringify(validateCaseResultV2.errors),
    );
    assert.deepEqual(result.queueReason, record.queueReason);
    assert.equal(result.result, null);
    assert.deepEqual(
      (await service.submit([INPUT]))[0]!.queueReason,
      record.queueReason,
    );
  }
  record.state = 'RUNNING';
  record.queueReason = null;
  assert.equal((await service.get(INPUT.caseId)).queueReason, null);
});

// 范围：业务步数决定默认预算，清理使用独立三分钟；不验证真实浏览器或模型耗时。
test('v2 默认业务每步贡献 300 秒，清理不占业务预算', () => {
  const profile: CaseProfile = { ...PROFILE, budget: { maxActions: 30 } };
  const task = compileCase(INPUT, profile);
  assert.equal(task.budget.timeoutMs, 900_000);
  assert.equal(task.budget.maxActions, 30);
  assert.equal(cleanupTask(task), null);
  assert.equal(
    compileCase({ ...INPUT, steps: [INPUT.steps[0]!] }, profile).budget
      .timeoutMs,
    300_000,
  );
  assert.equal(compileCase(INPUT, PROFILE).budget.timeoutMs, 900_000);
  assert.equal(cleanupTask(compileCase(INPUT, PROFILE)), null);
  const waiting = compileCase(
    {
      ...INPUT,
      steps: [{ ...INPUT.steps[0]!, wait: { durationMs: 600_000 } }],
    },
    profile,
  );
  assert.equal(waiting.budget.timeoutMs, 900_000);
  assert.equal(waiting.stepBudget!.steps[0]!.maxModelCalls, 20);
  assert.deepEqual(task.stepBudget!.cleanup, {
    timeoutMs: 180_000,
    maxActions: 10,
    maxModelCalls: 20,
  });
});

// 范围：默认双跑、两组完整预算、各自原任务收尾、查询和取消、配置改变后幂等；不模拟数据库隔离与模型质量。
test('v2 默认双跑返回两组独立结果，并取消两组', async () => {
  const profile: CaseProfile = {
    environment: PROFILE.environment,
    budget: { maxActions: 30 },
    evidenceKinds: ['DOM'],
  };
  const { service, records, tasks } = fixture(profile);
  const [result] = await service.submit([INPUT]);
  assert(
    validateCaseResultV2(result),
    JSON.stringify(validateCaseResultV2.errors),
  );
  assert.equal(result!.comparison!.arms.length, 2);
  assert.deepEqual(
    result!.comparison!.arms.map((arm) => arm.executionMode),
    ['llm', 'jev'],
  );
  const [llm, jev] = [...records.values()];
  assert.equal(llm!.definition.budget.timeoutMs, 900_000);
  assert.deepEqual(llm!.definition.budget, jev!.definition.budget);
  assert.notEqual(llm!.definition.resourceKey, jev!.definition.resourceKey);
  for (const arm of [llm!, jev!]) {
    assert(validateVerificationTask(arm.definition));
    assert.equal(cleanupTask(arm.definition), null);
    assert.deepEqual(arm.definition.cleanupStepIds, ['cleanup-1']);
  }
  const disabled = new CaseV2Service(tasks, undefined, 'https://proofrun.test');
  assert.deepEqual(await disabled.submit([INPUT]), [result]);
  const single = new CaseV2Service(tasks, PROFILE, 'https://proofrun.test');
  await single.submit([INPUT]);
  assert.equal(records.size, 2);
  // 只在另一组已持久化的步骤记录中出现的证据也可读取，未知证据仍拒绝。
  jev!.stepResults = [
    {
      stepId: 'step-1',
      status: 'COMPLETED',
      summary: '夹具',
      evidenceRefs: ['jev-evidence'],
      criteria: [],
      startedAt: null,
      finishedAt: null,
    },
  ];
  await service.requireEvidence(INPUT.caseId, 'jev-evidence');
  await assert.rejects(
    service.requireEvidence(INPUT.caseId, 'unknown-evidence'),
    { code: 'EVIDENCE_MISSING' },
  );
  const cancelled = await service.cancel(INPUT.caseId);
  assert(validateCaseResultV2(cancelled));
  assert(cancelled.comparison!.arms.every((arm) => arm.status === 'CANCELLED'));
});

// 范围：历史单组不会因新默认值追加执行，带模式后缀的业务身份不会碰撞；不覆盖真实并发事务。
test('v2 双跑命名空间与历史单组保持隔离', async () => {
  const { service, records, tasks } = fixture();
  await service.submit([INPUT]);
  const parallel = new CaseV2Service(
    tasks,
    { ...PROFILE, executionMode: 'parallel' },
    'https://proofrun.test',
  );
  assert.equal((await parallel.submit([INPUT]))[0]!.comparison, undefined);
  await parallel.submit([{ ...INPUT, caseId: `${INPUT.caseId}-jev` }]);
  assert.equal(records.size, 3);
});

// 范围：清理分段排序、身份冲突及最大 64 步协议；不连接数据库或浏览器。
test('清理始终置后，业务与清理身份唯一且支持各 32 步', () => {
  const input = {
    ...INPUT,
    steps: Array.from({ length: 32 }, (_, index) => ({
      ...INPUT.steps[0]!,
      exec_order: 100 + index,
    })),
    cleanup: Array.from({ length: 32 }, (_, index) => ({
      ...INPUT.cleanup[0]!,
      exec_order: 32 - index,
    })),
  };
  const task = compileCase(input as VerificationCaseV2, PROFILE);
  assert(
    validateVerificationTask(task),
    JSON.stringify(validateVerificationTask.errors),
  );
  assert.equal(task.steps!.length, 64);
  assert.equal(task.steps![32]!.stepId, 'cleanup-32');
  assert.equal(task.steps!.at(-1)!.stepId, 'cleanup-1');
  assert.throws(
    () =>
      compileCase(
        { ...INPUT, cleanup: [{ ...INPUT.cleanup[0]!, stepId: 'step-1' }] },
        PROFILE,
      ),
    { code: 'INVALID_CASE' },
  );
});

// 范围：新任务不生成独立清理，旧冻结定义仍可恢复旧任务；不验证历史数据库迁移。
test('仅历史定义保留独立清理兼容', () => {
  const task = compileCase(INPUT, PROFILE);
  assert.equal(cleanupTask(task), null);
  delete task.cleanupStepIds;
  task.steps!.pop();
  const legacy = cleanupTask(task)!;
  assert(validateVerificationTask(legacy));
  assert.equal(legacy.taskId, `cleanup-${task.taskId}`);
  assert.equal(legacy.parentTaskId, task.taskId);
});

// 范围：清理状态使用原任务步骤，故障业务不污染清理投影；不验证证据上传或真实验收。
test('同任务清理投影复用任务身份并保留独立状态', async () => {
  const { service, records } = fixture();
  await service.submit([INPUT]);
  const task = records.get(`case-v2-${INPUT.caseId}`)!;
  assert.equal(
    (await service.get(INPUT.caseId)).cleanup!.taskId,
    task.definition.taskId,
  );
  task.state = 'CANCELLED';
  assert.equal((await service.get(INPUT.caseId)).cleanup!.status, 'SKIPPED');
  task.state = 'RUNNING';
  task.stepResults = task.definition.steps!.map((step) => ({
    stepId: step.stepId!,
    status: 'COMPLETED',
    summary: '夹具已完成',
    criteria: [],
    evidenceRefs: [],
    startedAt: '2026-10-10T00:00:00Z',
    finishedAt: '2026-10-10T00:00:01Z',
  }));
  task.stepResults.at(-1)!.status = 'RUNNING';
  assert.equal((await service.get(INPUT.caseId)).cleanup!.status, 'RUNNING');
  task.stepResults.at(-1)!.status = 'COMPLETED';
  task.report = {
    protocolVersion: '0.1',
    taskId: task.definition.taskId,
    lifecycle: 'COMPLETED',
    executionDisposition: 'BLOCKED',
    verdict: null,
    summary: '业务阻塞',
    criteria: [],
    artifacts: [],
    steps: task.stepResults as NonNullable<
      import('@proofrun/contracts').VerificationReport['steps']
    >,
  };
  assert.equal(
    (await service.get(INPUT.caseId)).cleanup!.result!.outcome,
    'PASSED',
  );
});

// 范围：三种模式重跑保留冻结配置、完整步骤和末尾清理；不连接数据库、模型或浏览器。
test('v2 重跑保留原配置及整个 case，重试不重复创建', async () => {
  for (const executionMode of ['llm', 'jev', 'parallel'] as const) {
    const f = fixture({ ...PROFILE, executionMode });
    await f.service.submit([INPUT]);
    await f.service.cancel(INPUT.caseId);
    const before = structuredClone([...f.records.entries()]);
    const changed = new CaseV2Service(
      f.tasks,
      {
        ...PROFILE,
        executionMode: 'llm',
        budget: { timeoutMs: 99999, maxActions: 99 },
      },
      'https://proofrun.test',
    );
    const result = await changed.rerun(INPUT.caseId, 'new-case');
    assert(validateCaseResultV2(result));
    const fresh = f.records.get('case-v2-new-case')!;
    assert.equal(fresh.state, 'QUEUED');
    assert.equal(fresh.report, null);
    assert.deepEqual(fresh.definition.budget, {
      timeoutMs: 900_000,
      maxActions: 30,
    });
    assert.deepEqual(fresh.definition.environment, PROFILE.environment);
    assert.deepEqual(fresh.definition.caseV2Definition, {
      ...INPUT,
      caseId: 'new-case',
    });
    assert.deepEqual(fresh.definition.cleanupStepIds, ['cleanup-1']);
    assert.equal(fresh.definition.steps!.at(-1)!.stepId, 'cleanup-1');
    assert.notEqual(
      fresh.definition.resourceKey,
      before[0]![1].definition.resourceKey,
    );
    if (executionMode === 'parallel') {
      assert.deepEqual(
        result.comparison!.arms.map((a) => a.executionMode),
        ['llm', 'jev'],
      );
      assert.equal(f.records.size, 4);
    } else {
      assert.equal(result.comparison, undefined);
      assert.equal(fresh.definition.executionMode, executionMode);
      assert.equal(f.records.size, 2);
    }
    const count = f.records.size;
    assert.deepEqual(await changed.rerun(INPUT.caseId, 'new-case'), result);
    assert.equal(f.records.size, count);
    for (const [id, record] of before)
      assert.deepEqual(f.records.get(id), record);
  }
});

// 范围：无平台配置仍可重跑，非法身份、缺失源和冲突不会创建任务；不验证真实 HTTP 认证。
test('v2 重跑校验身份并沿用提交的冲突语义', async () => {
  const f = fixture();
  await f.service.submit([
    INPUT,
    { ...INPUT, caseId: 'occupied', platform: '另一份定义' },
  ]);
  const service = new CaseV2Service(
    f.tasks,
    undefined,
    'https://proofrun.test',
  );
  for (const id of [undefined, INPUT.caseId, '', 'a/b', 'a'.repeat(81), 42])
    await assert.rejects(
      service.rerun(INPUT.caseId, id),
      (e: unknown) => e instanceof ApiError && e.code === 'INVALID_RERUN',
    );
  await assert.rejects(
    service.rerun('missing', 'fresh'),
    (e: unknown) => e instanceof ApiError && e.code === 'CASE_MISSING',
  );
  await assert.rejects(
    service.rerun(INPUT.caseId, 'occupied'),
    (e: unknown) => e instanceof ApiError && e.code === 'CASE_CONFLICT',
  );
  assert.equal(f.records.size, 2);
  assert.equal((await service.rerun(INPUT.caseId, 'fresh')).caseId, 'fresh');
});

// 范围：模式倍率、纯等待、平台硬上限及显式历史预算复现；不验证模型质量或节点能力。
test('v2 新预算按步骤冻结，混合组请求加倍，超过上限直接拒绝', async () => {
  const arms = expandCaseTasks(
    compileCase(INPUT, { ...PROFILE, executionMode: 'parallel' }),
  );
  assert.equal(arms[0]!.stepBudget!.steps[0]!.maxModelCalls, 20);
  assert.equal(arms[1]!.stepBudget!.steps[0]!.maxModelCalls, 40);
  assert.equal(arms[1]!.stepBudget!.cleanup.maxModelCalls, 40);
  const pureWait = compileCase(
    {
      ...INPUT,
      steps: [
        { ...INPUT.steps[1]!, expected: [], wait: { durationMs: 90_000 } },
      ],
    },
    PROFILE,
  );
  assert.deepEqual(pureWait.stepBudget!.steps[0], {
    stepId: 'step-1',
    timeoutMs: 120_000,
    maxActions: 0,
    maxModelCalls: 0,
  });
  assert.throws(
    () =>
      compileCase(
        {
          ...INPUT,
          steps: [{ ...INPUT.steps[0]!, wait: { durationMs: 86_400_000 } }],
        },
        PROFILE,
      ),
    { code: 'CASE_BUDGET_EXCEEDED' },
  );
  const f = fixture();
  await f.service.submit([INPUT]);
  const original = f.records.get('case-v2-case-1')!.definition;
  delete original.stepBudget;
  original.budget = { timeoutMs: 300_000, maxActions: 30 };
  await f.service.rerun(INPUT.caseId, 'current-budget');
  await f.service.rerun(INPUT.caseId, 'original-budget', 'original');
  assert.equal(
    f.records.get('case-v2-current-budget')!.definition.stepBudget!.version,
    1,
  );
  assert.equal(
    f.records.get('case-v2-original-budget')!.definition.stepBudget,
    undefined,
  );
  assert.deepEqual(
    f.records.get('case-v2-original-budget')!.definition.budget,
    original.budget,
  );
});
