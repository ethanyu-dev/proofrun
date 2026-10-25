import type { TaskReader } from '../src/modules/tasks/reader.js';
import { cleanupTask } from './legacy-cleanup.js';
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
  assertCaseExecution,
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

// 范围：新 v2 默认 LLM、不生成登录复用开关，保留显式历史字段及人工权限；不验证真实浏览器或节点并发。
test('v2 默认 LLM 单组、独立会话并允许人工辅助，保留平台显式配置', () => {
  const { executionMode: _, ...defaults } = PROFILE;
  const task = compileCase(INPUT, defaults);
  const arms = currentTasks(task);
  assert.equal(task.executionMode, 'llm');
  assert.equal(arms.length, 1);
  assert.equal(task.stepBudget!.steps[0]!.maxModelCalls, 20);
  assert.equal(task.stepBudget!.cleanup.maxModelCalls, 20);
  for (const arm of arms) {
    assert.equal(arm.environment.reuseAuth, undefined);
    assert.equal(arm.environment.allowIntervention, true);
    assert(validateVerificationTask(arm));
  }
  assert.deepEqual(defaults.environment, {
    id: 'fixture',
    nodePool: 'fixture',
  });
  const explicit = compileCase(INPUT, {
    ...PROFILE,
    environment: {
      ...PROFILE.environment,
      reuseAuth: false,
      allowIntervention: false,
    },
  });
  assert.equal(explicit.executionMode, 'llm');
  assert.equal(explicit.environment.reuseAuth, false);
  assert.equal(explicit.environment.allowIntervention, false);
  assert.equal(currentTasks(explicit).length, 1);
  const guest = compileCase({ ...INPUT, session: { mode: 'guest' } }, defaults);
  assert.equal(guest.sessionPlan!.mode, 'guest');
});

/** 只模拟原子任务端口，事务隔离和并发由 PostgreSQL 集成测试检查。 */
function fixture(profile: CaseProfile = PROFILE) {
  const records = new Map<string, Awaited<ReturnType<TaskReader['task']>>>();
  let batches = 0;
  const tasks: Pick<Coordinator, 'submitCaseBatch' | 'cancel'> &
    Pick<TaskReader, 'task' | 'caseCleanup'> = {
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
        for (const d of currentTasks(definition))
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
  assert.equal(task.resourceKey, undefined);
});

// 范围：新 case 身份隔离、同身份编译稳定及同任务清理标记；不验证数据库调度或真实登录态。
test('v2 单运行不生成旧清理资源锁，新任务不继承历史清理阻塞', () => {
  const first = compileCase(INPUT, PROFILE);
  const second = compileCase({ ...INPUT, caseId: 'case-2' }, PROFILE);
  assert.equal(compileCase(INPUT, PROFILE).resourceKey, first.resourceKey);
  assert.equal(first.resourceKey, undefined);
  assert.equal(second.resourceKey, undefined);
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
  assert.equal(task.budget.maxActions, 34);
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
  assert.equal(waiting.stepBudget!.steps[0]!.maxModelCalls, 24);
  assert.deepEqual(task.stepBudget!.cleanup, {
    timeoutMs: 180_000,
    maxActions: 10,
    maxModelCalls: 20,
  });
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

// 范围：模拟升级前省略开关的冻结快照，重跑仍保留旧语义；不执行数据库迁移或真实浏览器。
test('历史 v2 重跑不被新默认值开启登录复用或人工辅助', async () => {
  const f = fixture();
  await f.service.submit([INPUT]);
  const original = f.records.get(`case-v2-${INPUT.caseId}`)!;
  delete original.definition.environment.reuseAuth;
  delete original.definition.environment.allowIntervention;
  await f.service.rerun(INPUT.caseId, 'historical-rerun');
  const fresh = f.records.get('case-run-historical-rerun')!;
  assert.equal(fresh.definition.environment.reuseAuth, undefined);
  assert.equal(fresh.definition.environment.allowIntervention, false);
  assert.deepEqual(original.definition.environment, PROFILE.environment);
});

// 范围：三种模式重跑保留冻结配置、完整步骤和末尾清理；不连接数据库、模型或浏览器。
test('v2 重跑保留原配置及整个 case，重试不重复创建', async () => {
  for (const executionMode of ['llm'] as const) {
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
    const fresh = f.records.get('case-run-new-case')!;
    assert.equal(fresh.state, 'QUEUED');
    assert.equal(fresh.report, null);
    assert.deepEqual(fresh.definition.budget, {
      timeoutMs: 900_000,
      maxActions: 34,
    });
    assert.deepEqual(
      fresh.definition.environment,
      before[0]![1].definition.environment,
    );
    assert.deepEqual(fresh.definition.caseV2Definition, {
      ...INPUT,
    });
    assert.deepEqual(fresh.definition.cleanupStepIds, ['cleanup-1']);
    assert.equal(fresh.definition.steps!.at(-1)!.stepId, 'cleanup-1');
    assert.equal(fresh.definition.resourceKey, undefined);
    assert.equal(result.comparison, undefined);
    assert.equal(fresh.definition.executionMode, executionMode);
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
  for (const id of [undefined, '', 'a/b', 'a'.repeat(81), 42])
    await assert.rejects(
      service.rerun(INPUT.caseId, id),
      (e: unknown) => e instanceof ApiError && e.code === 'INVALID_RERUN',
    );
  await assert.rejects(
    service.rerun('missing', 'fresh'),
    (e: unknown) => e instanceof ApiError && e.code === 'CASE_MISSING',
  );
  await service.rerun('occupied', 'occupied');
  await assert.rejects(
    service.rerun(INPUT.caseId, 'occupied'),
    (e: unknown) => e instanceof ApiError && e.code === 'CASE_CONFLICT',
  );
  assert.equal(f.records.size, 3);
  assert.equal(
    (await service.rerun(INPUT.caseId, 'fresh')).caseId,
    INPUT.caseId,
  );
});

// 范围：模式倍率、等待后准备检查额度、平台硬上限及显式历史预算复现；不验证模型质量或节点能力。
test('v2 新预算按步骤冻结，不再为混合组放大额度，超过上限直接拒绝', async () => {
  const arms = currentTasks(
    compileCase(INPUT, { ...PROFILE, executionMode: 'llm' }),
  );
  assert.equal(arms[0]!.stepBudget!.steps[0]!.maxModelCalls, 20);
  assert.equal(arms.length, 1);
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
    timeoutMs: 390_000,
    maxActions: 10,
    maxModelCalls: 20,
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
    f.records.get('case-run-current-budget')!.definition.stepBudget!.version,
    1,
  );
  assert.equal(
    f.records.get('case-run-original-budget')!.definition.stepBudget,
    undefined,
  );
  assert.deepEqual(
    f.records.get('case-run-original-budget')!.definition.budget,
    original.budget,
  );
});

// 范围：重跑时间扩容、双组冻结、旧记录及幂等性；端口夹具不验证真实超时或模型速度。
test('重跑可单独扩大步骤和清理时间且不改变动作额度或业务定义', async () => {
  const f = fixture({ ...PROFILE, executionMode: 'llm' });
  await f.service.submit([INPUT]);
  const source = f.records.get('case-v2-case-1')!.definition;
  source.stepBudget!.steps[0]!.timeoutMs = 1_200_000;
  source.budget.timeoutMs = 1_800_000;
  const before = structuredClone(source);
  await f.service.rerun(INPUT.caseId, 'extended', 'original', {
    stepTimeoutMs: 900_000,
    cleanupTimeoutMs: 600_000,
  });
  const fresh = f.records.get('case-run-extended')!.definition;
  assert.deepEqual(
    fresh.stepBudget!.steps.map((s) => s.timeoutMs),
    [1_200_000, 900_000, 900_000],
  );
  assert.equal(fresh.budget.timeoutMs, 3_000_000);
  assert.equal(fresh.budget.maxActions, before.budget.maxActions);
  assert.deepEqual(fresh.steps, before.steps);
  assert.deepEqual(fresh.acceptanceCriteria, before.acceptanceCriteria);
  for (const arm of ['case-run-extended']) {
    const task = f.records.get(arm)!.definition;
    assert(validateVerificationTask(task));
    assert.equal(task.stepBudget!.cleanup.timeoutMs, 600_000);
    const factor = task.executionMode === 'jev' ? 2 : 1;
    task.stepBudget!.steps.forEach((step, index) => {
      assert.equal(
        step.maxActions,
        before.stepBudget!.steps[index]!.maxActions,
      );
      assert.equal(
        step.maxModelCalls,
        before.stepBudget!.steps[index]!.maxModelCalls * factor,
      );
    });
  }
  const frozen = structuredClone(fresh);
  await f.service.rerun(INPUT.caseId, 'extended', 'current', {
    stepTimeoutMs: 1_800_000,
  });
  assert.deepEqual(f.records.get('case-run-extended')!.definition, frozen);
  assert.deepEqual(source, before);
});

// 范围：错误输入与会话总时间上限在写入前拒绝；不验证调度或浏览器行为。
test('重跑拒绝无效时间预算和超过会话上限的扩容', async () => {
  const f = fixture();
  await f.service.submit([INPUT]);
  for (const time of [
    null,
    {},
    [],
    10,
    { extra: 1 },
    { stepTimeoutMs: 0 },
    { cleanupTimeoutMs: -1 },
    { stepTimeoutMs: 1.5 },
    { stepTimeoutMs: '900000' },
    { stepTimeoutMs: Infinity },
    { stepTimeoutMs: 86_400_001 },
  ])
    await assert.rejects(
      f.service.rerun(INPUT.caseId, 'invalid', 'original', time),
      { code: 'INVALID_RERUN' },
    );
  await assert.rejects(
    f.service.rerun(INPUT.caseId, 'too-large', 'original', {
      stepTimeoutMs: 30_000_000,
    }),
    { code: 'CASE_BUDGET_EXCEEDED' },
  );
  assert.equal(f.records.size, 1);
});

// 范围：无逐步预算的旧快照可在新身份补编译，单项覆盖保留另一项；不代表历史运行已迁移。
test('历史总预算重跑扩容时生成逐步计划且保留旧动作上限', async () => {
  const f = fixture();
  await f.service.submit([INPUT]);
  const old = f.records.get('case-v2-case-1')!.definition;
  delete old.stepBudget;
  old.budget = { timeoutMs: 300_000, maxActions: 29 };
  await f.service.rerun(INPUT.caseId, 'cleanup-time', 'original', {
    cleanupTimeoutMs: 600_000,
  });
  const fresh = f.records.get('case-run-cleanup-time')!.definition;
  assert.deepEqual(fresh.budget, { timeoutMs: 900_000, maxActions: 29 });
  assert.equal(fresh.stepBudget!.cleanup.timeoutMs, 600_000);
  assert(fresh.stepBudget!.steps.every((s) => s.timeoutMs === 300_000));
  assert.equal(old.stepBudget, undefined);
});

// 范围：稳定排序后 setup 拆组，cleanup 不占业务 tab，双跑保持计划；不验证真实浏览器并发。
test('profile 按 setup 分组且保持原步骤身份', () => {
  const input = structuredClone(INPUT);
  input.steps.push({
    ...input.steps[1]!,
    stepId: 'second-setup',
    exec_order: 6,
  });
  input.steps.push({
    ...input.steps[0]!,
    stepId: 'second-verify',
    exec_order: 7,
  });
  const task = compileCase(input, PROFILE);
  assert.deepEqual(task.profilePlan, {
    version: 1,
    maxConcurrency: 2,
    environmentGateStepId: 'step-2',
    groups: [
      { id: 'group-1', stepIds: ['step-2', 'step-1', 'step-3'] },
      { id: 'group-2', stepIds: ['second-setup', 'second-verify'] },
    ],
  });
  assert(
    task.cleanupStepIds!.every(
      (id) => !task.profilePlan!.groups.some((g) => g.stepIds.includes(id)),
    ),
  );
});

// 范围：提交及重跑采用新并发、双跑计划一致、旧任务快照不被修改；不覆盖真实数据库或模型限流。
test('多组 v2 提交和重跑最多并发八组，保留历史任务的冻结值', async () => {
  for (const count of [5, 9]) {
    const input = structuredClone(INPUT);
    input.steps = Array.from({ length: count }, (_, i) => [
      { ...INPUT.steps[1]!, stepId: `setup-${i}`, exec_order: i * 2 + 1 },
      { ...INPUT.steps[0]!, stepId: `verify-${i}`, exec_order: i * 2 + 2 },
    ]).flat() as VerificationCaseV2['steps'];
    const arms = currentTasks(
      compileCase(input, { ...PROFILE, executionMode: 'llm' }),
    );
    assert.equal(arms.length, 1);
    for (const arm of arms) {
      assert.equal(arm.profilePlan!.maxConcurrency, Math.min(count, 8));
      assert(validateVerificationTask(arm));
    }
    const f = fixture();
    await f.service.submit([input]);
    const original = f.records.get('case-v2-case-1')!.definition;
    original.profilePlan!.maxConcurrency = 2;
    await f.service.rerun(input.caseId, 'new-parallelism');
    assert.equal(original.profilePlan!.maxConcurrency, 2);
    assert.equal(
      f.records.get('case-run-new-parallelism')!.definition.profilePlan!
        .maxConcurrency,
      Math.min(count, 8),
    );
  }
});

/** 为旧批量夹具包装当前准入结果；不构造双跑或清理执行。 */
function currentTasks(task: import('@proofrun/contracts').VerificationTask) {
  assertCaseExecution(task);
  return [task];
}

// 范围：历史身份显式迁移、重新编译及快照不变；内存端口不覆盖数据库事务、真实登录或账号租约。
test('历史身份重跑可显式改用访客、人工登录或 DevPass', async () => {
  for (const session of [
    { mode: 'guest' as const },
    { mode: 'manual' as const },
    {
      mode: 'external' as const,
      external: { provider: 'devpass', platform: 'fixture', poolId: 'members' },
      requirements: [
        {
          id: 'member',
          description: '会员身份',
          method: 'text' as const,
          value: '会员',
        },
      ],
    },
  ]) {
    const f = fixture();
    await f.service.submit([INPUT]);
    const old = f.records.get(`case-v2-${INPUT.caseId}`)!;
    old.definition.sessionPlan = {
      version: 1,
      mode: 'pool',
      library: true,
      selection: 'pending',
      candidates: [],
      requirements: [],
      preparationMs: 120000,
    };
    old.definition.caseV2Definition!.session = {
      mode: 'identity',
      identityRef: 'retired',
    } as never;
    old.definition.environment.auth = {
      nodeId: 'retired-node',
      stateId: 'retired-state',
      restore: true,
    };
    old.definition.environment.allowIntervention = false;
    const before = structuredClone(old);
    await f.service.rerun(INPUT.caseId, 'no-override');
    const automatic = f.records.get('case-run-no-override')!.definition;
    assert.ok(automatic.sessionPlan?.automatic);
    assert.equal(automatic.environment.auth, undefined);
    assert.deepEqual(automatic.caseV2Definition!.steps, INPUT.steps);
    assert.deepEqual(old, before);
    await f.service.rerun(
      INPUT.caseId,
      'migrated',
      'current',
      undefined,
      session,
    );
    const next = f.records.get('case-run-migrated')!.definition;
    assert.ok(
      validateVerificationTask(next),
      JSON.stringify(validateVerificationTask.errors),
    );
    assert.equal(next.sessionPlan!.mode, session.mode);
    assert.deepEqual(next.sessionPlan!.candidates, []);
    assert.equal(next.sessionPlan!.library, undefined);
    assert.equal(next.sessionPlan!.selection, undefined);
    assert.equal(next.environment.auth, undefined);
    assert.equal(next.environment.allowIntervention, session.mode === 'manual');
    assert.deepEqual(next.caseV2Definition!.steps, INPUT.steps);
    assert.deepEqual(next.rerunSession, session);
    assert.deepEqual(old, before);
    const count = f.records.size;
    await f.service.rerun(
      INPUT.caseId,
      'migrated',
      'current',
      undefined,
      session,
    );
    assert.equal(f.records.size, count);
    for (const changed of [
      undefined,
      { mode: session.mode === 'guest' ? 'manual' : 'guest' },
    ])
      await assert.rejects(
        f.service.rerun(
          INPUT.caseId,
          'migrated',
          'current',
          undefined,
          changed,
        ),
        { code: 'CASE_CONFLICT' },
      );
  }
});

// 范围：覆盖输入严格校验及业务准备要求的冲突；不验证站点是否真的处于登录或访客状态。
test('重跑拒绝旧身份参数和无效 DevPass，显式身份不能绕过业务冲突', async () => {
  const f = fixture();
  await f.service.submit([INPUT]);
  for (const session of [
    null,
    {},
    { mode: 'pool', poolRef: 'retired' },
    { mode: 'guest', cookie: 'forbidden' },
    { mode: 'external' },
    {
      mode: 'external',
      external: { provider: 'devpass', platform: 'fixture', poolId: 'members' },
      requirements: [],
    },
  ])
    await assert.rejects(
      f.service.rerun(
        INPUT.caseId,
        'invalid-session',
        'current',
        undefined,
        session,
      ),
      { code: 'INVALID_RERUN' },
    );
  const guest = {
    ...INPUT,
    caseId: 'explicit-guest',
    steps: [{ ...INPUT.steps[1]!, description: '保持未登录' }, INPUT.steps[0]!],
  };
  await f.service.submit([guest]);
  await assert.rejects(
    f.service.rerun(guest.caseId, 'conflicting-session', 'current', undefined, {
      mode: 'manual',
    }),
    { code: 'ENVIRONMENT_CONFIG_CONFLICT' },
  );
  assert.equal(f.records.has('case-run-invalid-session'), false);
  assert.equal(f.records.has('case-run-conflicting-session'), false);
});

// 范围：重配外部身份后按最终时间预算申请租期，超过外部上限时不入队；不证明真实 DevPass 租约可续期。
test('DevPass 重跑按最终预算计算租期并拒绝超过两小时的运行', async () => {
  const f = fixture();
  await f.service.submit([INPUT]);
  const session = {
    mode: 'external',
    external: { provider: 'devpass', platform: 'fixture', poolId: 'members' },
    requirements: [
      { id: 'member', description: '会员身份', method: 'text', value: '会员' },
    ],
  };
  await f.service.rerun(
    INPUT.caseId,
    'external-time',
    'original',
    { stepTimeoutMs: 600000 },
    session,
  );
  const task = f.records.get('case-run-external-time')!.definition;
  const plan = task.stepBudget!;
  assert.equal(
    task.sessionPlan!.external!.durationSeconds,
    Math.ceil(
      (task.budget.timeoutMs +
        task.sessionPlan!.preparationMs +
        plan.settleMs * plan.steps.length +
        plan.cleanup.timeoutMs +
        300000 +
        30000) /
        1000,
    ),
  );
  await assert.rejects(
    f.service.rerun(
      INPUT.caseId,
      'external-too-long',
      'current',
      { stepTimeoutMs: 2400000 },
      session,
    ),
    { code: 'EXTERNAL_ACCOUNT_BUDGET' },
  );
  assert.equal(f.records.has('case-run-external-too-long'), false);
});
