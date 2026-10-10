import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeReport } from '../../contracts/dist/index.js';

/** 只构造结论事实；证据真实性仍由报告写入校验和真实环境验收负责。 */
function report(verdicts, disposition = 'EXECUTED', verdict = 'PASSED') {
  return {
    executionDisposition: disposition,
    verdict: disposition === 'EXECUTED' ? verdict : null,
    criteria: verdicts.map((verdict, i) => ({ criterionId: `c${i}`, verdict })),
  };
}

// 范围：未生成报告和空验收范围不误报通过；不覆盖数据库或浏览器。
test('无报告为 null，零验收项无法得出产品结论', () => {
  assert.deepEqual(summarizeReport(null, ['c0']), {
    reportStatus: null,
    criteriaCounts: null,
  });
  assert.equal(summarizeReport(report([]), []).reportStatus, 'INCONCLUSIVE');
});

// 范围：全部覆盖、跳过、缺项和明确失败的优先级；不证明夹具业务结论有效。
test('报告状态按定义范围汇总并保留未覆盖项', () => {
  assert.equal(
    summarizeReport(report(['PASSED', 'PASSED']), ['c0', 'c1']).reportStatus,
    'PASSED',
  );
  const partial = summarizeReport(
    report(['PASSED', 'INCONCLUSIVE', 'SKIPPED']),
    ['c0', 'c1', 'c2', 'c3'],
  );
  assert.deepEqual(partial, {
    reportStatus: 'INCONCLUSIVE',
    criteriaCounts: {
      total: 4,
      passed: 1,
      failed: 0,
      inconclusive: 1,
      skipped: 2,
    },
  });
  assert.equal(
    summarizeReport(report(['FAILED', 'SKIPPED'], 'BLOCKED'), ['c0', 'c1'])
      .reportStatus,
    'FAILED',
  );
});

// 范围：阻塞或错误不能凭局部通过升格为整体通过；不覆盖实际超时和租约流程。
test('阻塞和故障报告独立于验收通过状态', () => {
  for (const disposition of ['BLOCKED', 'ERROR']) {
    assert.equal(
      summarizeReport(report(['PASSED'], disposition), ['c0']).reportStatus,
      'INCONCLUSIVE',
    );
    assert.equal(
      summarizeReport(report(['SKIPPED'], disposition), ['c0']).reportStatus,
      'INCONCLUSIVE',
    );
  }
  assert.equal(
    summarizeReport(report(['PASSED'], 'EXECUTED', 'INCONCLUSIVE'), ['c0'])
      .reportStatus,
    'INCONCLUSIVE',
  );
});

// 范围：历史异常数据中的未知、重复身份不放大覆盖统计；不代替写入端身份校验。
test('重复项不扩大通过数量，未知项不进入定义范围', () => {
  const facts = report(['PASSED', 'FAILED']);
  facts.criteria[1].criterionId = 'unknown';
  assert.equal(summarizeReport(facts, ['c0']).criteriaCounts.total, 1);
  facts.criteria.push({ criterionId: 'c0', verdict: 'PASSED' });
  assert.equal(summarizeReport(facts, ['c0']).reportStatus, 'INCONCLUSIVE');
});

// 范围：清理独立于业务判定，保留前置受阻、业务失败及缺失记录；不验证报告证据真实性。
test('后续清理不影响业务判定或验收统计', () => {
  const scope = {
    cleanupStepIds: ['cleanup-1'],
    steps: [
      { stepId: 'step-1' },
      { stepId: 'step-2' },
      { stepId: 'cleanup-1' },
    ],
    acceptanceCriteria: [
      { id: 'c0', stepId: 'step-2' },
      { id: 'c1', stepId: 'cleanup-1' },
    ],
  };
  const facts = {
    ...report(['PASSED', 'FAILED'], 'ERROR'),
    steps: [
      { stepId: 'step-1', status: 'COMPLETED' },
      { stepId: 'step-2', status: 'COMPLETED' },
      { stepId: 'cleanup-1', status: 'ERROR' },
    ],
  };
  let summary = summarizeReport(facts, ['c0', 'c1'], scope);
  assert.equal(summary.reportStatus, 'PASSED');
  assert.deepEqual(summary.criteriaCounts, {
    total: 1,
    passed: 1,
    failed: 0,
    inconclusive: 0,
    skipped: 0,
  });
  facts.verdict = 'FAILED';
  assert.equal(
    summarizeReport(facts, ['c0', 'c1'], scope).reportStatus,
    'PASSED',
  );
  facts.steps[0].status = 'BLOCKED';
  assert.equal(
    summarizeReport(facts, ['c0', 'c1'], scope).reportStatus,
    'INCONCLUSIVE',
  );
  facts.criteria[0].verdict = 'FAILED';
  assert.equal(
    summarizeReport(facts, ['c0', 'c1'], scope).reportStatus,
    'FAILED',
  );
  facts.criteria[0].verdict = 'PASSED';
  facts.steps = [];
  assert.equal(
    summarizeReport(facts, ['c0', 'c1'], scope).reportStatus,
    'INCONCLUSIVE',
  );
});
