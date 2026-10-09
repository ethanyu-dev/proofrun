import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validateCaseResult,
  type VerificationCase,
  type VerificationTask,
  type VerificationReport,
} from '@proofrun/contracts';
import { ApiError, canonical } from '../src/domain.js';
import { CaseService } from '../src/modules/cases/service.js';
import {
  validateCaseProfile,
  type CaseProfile,
} from '../src/modules/cases/profile.js';
import type { Coordinator } from '../src/modules/scheduling/coordinator.js';

/** 夹具只模拟任务存档；不连接数据库、节点或模型。 */
const PROFILE: CaseProfile = {
  environment: {
    id: 'private-environment',
    nodePool: 'private-pool',
    auth: { nodeId: 'private-node', stateId: 'private-login', restore: true },
  },
  budget: { timeoutMs: 60000, maxActions: 20 },
  executionMode: 'llm',
  evidenceKinds: ['DOM'],
};
const INPUT: VerificationCase = {
  caseId: 'notification-1',
  description: '验证通知默认状态',
  url: 'https://app.example.test/settings',
  steps: ['打开设置', '观察通知开关'],
  acceptanceCriteria: [
    { id: 'enabled', description: '通知开关', expectedResult: '开启' },
  ],
};

/** 提供同定义幂等与冲突端口，以独立检查公开适配层的行为。 */
function fixture() {
  const records = new Map<string, Awaited<ReturnType<Coordinator['task']>>>();
  const tasks: Pick<Coordinator, 'submit' | 'task' | 'cancel'> = {
    async submit(definition: VerificationTask) {
      const existing = records.get(definition.taskId);
      if (existing && canonical(existing.definition) !== canonical(definition))
        throw new ApiError(409, 'TASK_CONFLICT', 'conflict');
      const record = existing ?? {
        definition: structuredClone(definition),
        state: 'QUEUED' as const,
        report: null,
        reportStatus: null,
        criteriaCounts: null,
        executions: [],
      };
      records.set(definition.taskId, record);
      return record;
    },
    async task(id) {
      const record = records.get(id);
      if (!record) throw new ApiError(404, 'TASK_MISSING', 'missing');
      return record;
    },
    async cancel(id) {
      const record = await tasks.task(id);
      record.state = 'CANCELLED';
      return record;
    },
  };
  return {
    tasks,
    records,
    service: new CaseService(tasks, PROFILE, 'https://proofrun.example.test'),
  };
}

// 范围：环境等配置只从平台注入、业务步骤和验收原文保留；不验证页面语义或实际动作。
test('case 只接受业务定义并转换成内部任务', async () => {
  const { service, records } = fixture();
  const result = await service.submit(INPUT);
  assert.deepEqual(result, {
    caseId: INPUT.caseId,
    status: 'QUEUED',
    reportStatus: null,
    criteriaCounts: null,
    result: null,
  });
  assert(validateCaseResult(result));
  const task = records.get(`case-${INPUT.caseId}`)!.definition;
  assert.deepEqual(task.environment, PROFILE.environment);
  assert.equal(task.target.url, INPUT.url);
  assert(task.objective.startsWith(INPUT.description));
  assert.deepEqual(task.caseDefinition, INPUT);
  assert.match(task.objective, /1\. 打开设置\n2\. 观察通知开关/);
  assert.equal(
    task.acceptanceCriteria[0]!.expectedResult,
    INPUT.acceptanceCriteria[0]!.expectedResult,
  );
  assert.deepEqual(task.acceptanceCriteria[0]!.evidenceKinds, ['DOM']);
  for (const field of [
    'environment',
    'target',
    'budget',
    'executionMode',
    'protocolVersion',
  ]) {
    await assert.rejects(service.submit({ ...INPUT, [field]: {} }), {
      code: 'INVALID_CASE',
    });
  }
  await assert.rejects(
    service.submit({
      ...INPUT,
      acceptanceCriteria: [
        { ...INPUT.acceptanceCriteria[0], evidenceKinds: ['TRACE'] },
      ],
    }),
    { code: 'INVALID_CASE' },
  );
  await assert.rejects(
    service.submit({
      ...INPUT,
      acceptanceCriteria: [
        ...INPUT.acceptanceCriteria,
        ...INPUT.acceptanceCriteria,
      ],
    }),
    { code: 'INVALID_CASE', statusCode: 422 },
  );
});

// 范围：公开描述与 HTTP(S) 入口必填，旧字段和无效地址被拒绝；不检查站点可达性或登录状态。
test('case 必须提供 description 和有效的待测入口', async () => {
  const { service, records } = fixture();
  const { url: _, ...withoutUrl } = INPUT;
  await assert.rejects(service.submit(withoutUrl), { code: 'INVALID_CASE' });
  const { description, ...withoutDescription } = INPUT;
  await assert.rejects(service.submit(withoutDescription), {
    code: 'INVALID_CASE',
  });
  await assert.rejects(
    service.submit({ ...withoutDescription, objective: description }),
    { code: 'INVALID_CASE' },
  );
  await assert.rejects(service.submit({ ...INPUT, objective: description }), {
    code: 'INVALID_CASE',
  });
  for (const url of [
    '',
    '/settings',
    'app.example.test',
    'file:///tmp/page.html',
    'javascript:alert(1)',
    'ftp://example.test',
  ]) {
    await assert.rejects(service.submit({ ...INPUT, url }), {
      code: 'INVALID_CASE',
    });
  }
  assert.equal(records.size, 0);
  await service.submit({
    ...INPUT,
    url: 'http://127.0.0.1:8080/settings?tab=mail#notification',
  });
  assert.equal(
    records.get(`case-${INPUT.caseId}`)!.definition.target.url,
    'http://127.0.0.1:8080/settings?tab=mail#notification',
  );
});

// 范围：配置更改或删除后原 case 仍幂等，地址和步骤变化均冲突；真实并发锁由数据库集成测试覆盖。
test('case 重提固定原配置且不能改写业务定义', async () => {
  const { service, records, tasks } = fixture();
  await service.submit(INPUT);
  const changed = new CaseService(
    tasks,
    { ...PROFILE, budget: { timeoutMs: 120000, maxActions: 40 } },
    'https://proofrun.example.test',
  );
  await changed.submit(INPUT);
  const disabled = new CaseService(
    tasks,
    undefined,
    'https://proofrun.example.test',
  );
  await disabled.submit(INPUT);
  assert.equal(records.size, 1);
  assert.equal(
    records.get(`case-${INPUT.caseId}`)!.definition.target.url,
    INPUT.url,
  );
  assert.deepEqual(
    records.get(`case-${INPUT.caseId}`)!.definition.budget,
    PROFILE.budget,
  );
  await assert.rejects(
    changed.submit({ ...INPUT, url: 'https://another.example.test/' }),
    { code: 'CASE_CONFLICT' },
  );
  await assert.rejects(changed.submit({ ...INPUT, steps: ['不同操作'] }), {
    code: 'CASE_CONFLICT',
  });
  await assert.rejects(disabled.submit({ ...INPUT, caseId: 'new-case' }), {
    code: 'CASE_NOT_CONFIGURED',
  });
  assert.equal((await disabled.cancel(INPUT.caseId)).status, 'CANCELLED');
});

// 范围：结果只投影业务字段、证据限定于本 case 报告；报告由夹具生成，不证明真实验收通过。
test('case 结果隐藏执行配置并限制证据归属', async () => {
  const { service, records, tasks } = fixture();
  await service.submit(INPUT);
  const record = records.get(`case-${INPUT.caseId}`)!;
  const report: VerificationReport = {
    protocolVersion: '0.1',
    taskId: record.definition.taskId,
    lifecycle: 'COMPLETED',
    executionDisposition: 'EXECUTED',
    verdict: 'PASSED',
    summary: '夹具结论',
    criteria: [
      {
        criterionId: 'enabled',
        verdict: 'PASSED',
        summary: '夹具观察',
        evidenceRefs: ['evidence-1'],
      },
    ],
    artifacts: [
      {
        id: 'evidence-1',
        kind: 'DOM',
        uri: 'https://internal.example.test/file',
        sha256: 'a'.repeat(64),
      },
    ],
  };
  record.state = 'COMPLETED';
  record.report = report;
  record.executions = [{ id: 'private-execution', node_id: 'private-node' }];
  const result = await service.get(INPUT.caseId);
  assert(validateCaseResult(result));
  assert.equal(result.result?.outcome, 'PASSED');
  assert.equal(
    result.result?.evidence[0]?.url,
    `https://proofrun.example.test/v1/cases/${INPUT.caseId}/evidence/evidence-1`,
  );
  assert(!JSON.stringify(result).includes('private-'));
  assert(!JSON.stringify(result).includes('internal.example.test'));
  await service.requireEvidence(INPUT.caseId, 'evidence-1');
  await assert.rejects(
    service.requireEvidence(INPUT.caseId, 'other-evidence'),
    { code: 'EVIDENCE_MISSING' },
  );
  const { caseDefinition: _, ...internal } = record.definition;
  await tasks.submit({ ...internal, taskId: 'case-internal' });
  await assert.rejects(service.get('internal'), { code: 'CASE_MISSING' });
  await assert.rejects(service.get('../internal'), { code: 'CASE_MISSING' });
  record.report = {
    ...report,
    executionDisposition: 'BLOCKED',
    verdict: null,
    criteria: [
      { ...report.criteria[0]!, verdict: 'SKIPPED', evidenceRefs: [] },
    ],
    artifacts: [],
  };
  assert.equal((await service.get(INPUT.caseId)).result?.outcome, 'BLOCKED');
  await assert.rejects(service.requireEvidence(INPUT.caseId, 'evidence-1'), {
    code: 'EVIDENCE_MISSING',
  });
});

// 范围：服务端配置拒绝旧默认地址、并行和超限预算；不证明节点、账号或站点真实可用。
test('case 平台配置必须完整且只允许单组执行', () => {
  assert.deepEqual(validateCaseProfile(PROFILE), PROFILE);
  for (const invalid of [
    null,
    {},
    { ...PROFILE, executionMode: 'parallel' },
    { ...PROFILE, budget: { timeoutMs: 86400001, maxActions: 20 } },
    { ...PROFILE, evidenceKinds: [] },
    { ...PROFILE, target: { url: 'https://old-default.example.test' } },
    { ...PROFILE, unexpected: true },
  ]) {
    assert.throws(() => validateCaseProfile(invalid));
  }
});

// 范围：并发冲突后查询故障保留原可重试错误，不误报业务定义冲突；不模拟真实数据库断线。
test('case 并发冲突回读故障不伪装成定义冲突', async () => {
  const { tasks } = fixture();
  let reads = 0;
  const service = new CaseService(
    {
      ...tasks,
      async task() {
        if (++reads === 1) throw new ApiError(404, 'TASK_MISSING', 'missing');
        throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'unavailable');
      },
      async submit() {
        throw new ApiError(409, 'TASK_CONFLICT', 'conflict');
      },
    },
    PROFILE,
    'https://proofrun.example.test',
  );
  await assert.rejects(service.submit(INPUT), {
    code: 'DATABASE_UNAVAILABLE',
    statusCode: 503,
  });
});

// 范围：公开 v1 查询与取消均携带统一报告状态，旧 outcome 保持兼容；不连接真实执行环境。
test('v1 对外返回报告状态和验收统计', async () => {
  const { service, records } = fixture();
  const queued = await service.submit(INPUT);
  assert.equal(queued.reportStatus, null);
  assert.equal(queued.criteriaCounts, null);
  const record = records.get(`case-${INPUT.caseId}`)!;
  record.state = 'ERROR';
  record.report = {
    protocolVersion: '0.1',
    taskId: record.definition.taskId,
    lifecycle: 'COMPLETED',
    executionDisposition: 'ERROR',
    verdict: null,
    summary: '执行异常夹具',
    criteria: [
      {
        criterionId: 'enabled',
        verdict: 'SKIPPED',
        summary: '未执行',
        evidenceRefs: [],
      },
    ],
    artifacts: [],
  };
  const result = await service.get(INPUT.caseId);
  assert(validateCaseResult(result));
  assert.equal(result.status, 'ERROR');
  assert.equal(result.reportStatus, 'INCONCLUSIVE');
  assert.equal(result.criteriaCounts?.skipped, 1);
  assert.equal(result.result?.outcome, 'ERROR');
  assert.equal(
    (await service.cancel(INPUT.caseId)).reportStatus,
    'INCONCLUSIVE',
  );
});
