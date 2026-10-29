import assert from 'node:assert/strict';
import test from 'node:test';
import {
  summarizeReport,
  summarizeRequest,
  summarizeRequestCase,
  validateVerificationRequest,
  validateRequestRerun,
} from '../../contracts/dist/index.js';

/** 报告由夹具构造，只验证统计语义，不证明浏览器执行或业务标准正确。 */
const CRITERION = {
  id: 'check-expected-1',
  stepId: 'check',
  description: '检查结果',
  expectedResult: '结果可见',
  evidenceKinds: ['DOM'],
};
function arm(
  mode,
  {
    state = 'COMPLETED',
    verdict = 'PASSED',
    missing = false,
    duplicate = false,
    cleanupError = false,
    setupBlocked = false,
  } = {},
) {
  const criteria = [
    {
      criterionId: CRITERION.id,
      verdict,
      summary: '夹具依据',
      evidenceRefs: [],
    },
  ];
  if (duplicate) criteria.push({ ...criteria[0] });
  const report = missing
    ? null
    : {
        executionDisposition:
          cleanupError || setupBlocked ? 'ERROR' : 'EXECUTED',
        verdict: cleanupError || setupBlocked ? null : verdict,
        summary: '夹具报告',
        criteria,
        steps: [
          { stepId: 'prepare', status: setupBlocked ? 'BLOCKED' : 'COMPLETED' },
          { stepId: 'check', status: 'COMPLETED' },
          { stepId: 'cleanup', status: cleanupError ? 'ERROR' : 'COMPLETED' },
        ],
      };
  const scope = {
    cleanupStepIds: ['cleanup'],
    steps: [{ stepId: 'prepare' }, { stepId: 'check' }, { stepId: 'cleanup' }],
    acceptanceCriteria: [CRITERION],
  };
  return {
    taskId: `task-${mode}`,
    executionMode: mode,
    createdAt: '2026-10-19T00:00:00.000Z',
    archivedAt: null,
    result: {
      caseId: 'fixture',
      status: state,
      ...summarizeReport(report, [CRITERION.id], scope),
      result: report
        ? { outcome: verdict, summary: '夹具', criteria, evidence: [] }
        : null,
      steps: [],
      cleanup: null,
    },
  };
}
function member(id, arms) {
  return summarizeRequestCase({
    caseId: id,
    title: id,
    executionOrigin: 'created',
    sourceCaseId: null,
    criteria: [CRITERION],
    arms,
  });
}

// 范围：单执行按业务身份统计，跨 case 同名标准不合并；不运行模型。
test('跨 case 同名验收项独立统计', () => {
  const result = summarizeRequest([
    member('a', [arm('llm')]),
    member('b', [arm('llm')]),
  ]);
  assert.deepEqual(result.uniqueCriteriaCounts, {
    total: 2,
    passed: 2,
    failed: 0,
    inconclusive: 0,
    skipped: 0,
    pending: 0,
  });
  assert.equal(result.executionCounts.total, 2);
  assert.equal(result.reportStatus, 'PASSED');
  assert.deepEqual(
    result.byExecutionMode.map((m) => [
      m.executionMode,
      m.caseCount,
      m.missingReportCount,
    ]),
    [['llm', 2, 0]],
  );
});
// 范围：运行中与终态缺报告分别表达，不把单组完成当整请求完成；不模拟失联恢复。
test('缺报告与部分结果保留覆盖缺口', () => {
  const running = summarizeRequest([
    member('a', [arm('llm')]),
    member('b', [arm('llm', { state: 'QUEUED', missing: true })]),
  ]);
  assert.equal(running.reportStatus, null);
  assert.equal(running.reportPhase, 'PARTIAL');
  assert.equal(running.uniqueCriteriaCounts.pending, 1);
  const stopped = summarizeRequest([
    member('a', [arm('llm')]),
    member('b', [arm('llm', { state: 'TIMED_OUT', missing: true })]),
  ]);
  assert.equal(stopped.reportStatus, 'INCONCLUSIVE');
  assert.equal(stopped.reportPhase, 'FINAL');
  assert.equal(stopped.uniqueCriteriaCounts.skipped, 1);
  const cancelled = summarizeRequest([
    member('a', [arm('llm', { state: 'CANCELLED', missing: true })]),
  ]);
  assert.equal(cancelled.reportStatus, 'INCONCLUSIVE');
  assert.equal(cancelled.uniqueCriteriaCounts.skipped, 1);
  assert.equal(cancelled.reportCoverage.missing, 1);
});
// 范围：失败与未知 case 的汇总优先级，不解释产品根因。
test('失败保留且进行中请求不提前定论', () => {
  const failed = member('a', [arm('llm', { verdict: 'FAILED' })]);
  const result = summarizeRequest([
    failed,
    member('b', [arm('llm', { verdict: 'INCONCLUSIVE' })]),
  ]);
  assert.equal(result.reportStatus, 'FAILED');
  assert.equal(result.uniqueCriteriaCounts.inconclusive, 1);
  const partial = summarizeRequest([
    member('a', [arm('llm', { verdict: 'FAILED' })]),
    member('b', [arm('llm', { state: 'RUNNING', missing: true })]),
  ]);
  assert.equal(partial.reportStatus, null);
  assert.equal(partial.observedFailureCount, 1);
});
// 范围：复用现有单组业务判定，清理与前置条件对结果影响不同；不验证真实清理动作。
test('清理失败不污染业务通过，前置未完成不被标准通过掩盖', () => {
  assert.equal(
    summarizeRequest([member('a', [arm('llm', { cleanupError: true })])])
      .reportStatus,
    'PASSED',
  );
  const blocked = summarizeRequest([
    member('a', [arm('llm', { setupBlocked: true })]),
  ]);
  assert.equal(blocked.uniqueCriteriaCounts.passed, 1);
  assert.equal(blocked.reportStatus, 'INCONCLUSIVE');
});
// 范围：历史异常重复记录不会扩大覆盖或冒充通过；不校验报告写入端证据归属。
test('重复标准记录保守判定且不增加分母', () => {
  const result = summarizeRequest([
    member('a', [arm('llm', { duplicate: true })]),
  ]);
  assert.equal(result.uniqueCriteriaCounts.total, 1);
  assert.equal(result.uniqueCriteriaCounts.inconclusive, 1);
  assert.equal(result.reportStatus, 'INCONCLUSIVE');
});
// 范围：对象与重跑请求的结构边界，跨成员唯一性仍由 API 集成测试验证。
test('请求 Schema 拒绝未知字段和无效身份', () => {
  const input = {
    requestId: 'request-1',
    cases: [
      {
        caseId: 'a',
        platform: '夹具',
        entry: 'https://example.test',
        steps: [
          {
            type: 'verification',
            url: 'https://example.test',
            exec_order: 1,
            description: '检查',
            policy: [],
            expected: ['可见'],
          },
        ],
        cleanup: [],
      },
    ],
  };
  assert.ok(validateVerificationRequest(input));
  for (const invalid of [
    { ...input, title: '  ' },
    { ...input, extra: true },
    { ...input, requestId: '../bad' },
    { ...input, cases: [] },
  ])
    assert.equal(validateVerificationRequest(invalid), false);
  assert.ok(
    validateRequestRerun({
      requestId: 'new',
      caseIds: [{ sourceCaseId: 'a', caseId: 'b' }],
    }),
  );
  assert.equal(
    validateRequestRerun({
      requestId: 'new',
      caseIds: [{ sourceCaseId: 'a', caseId: 'b' }],
      timeBudget: { stepTimeoutMs: 0 },
    }),
    false,
  );
});
