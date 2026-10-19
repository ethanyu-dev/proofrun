import assert from 'node:assert/strict';
import test from 'node:test';
import {
  requestCaseVerification,
  requestVerification,
} from '../../contracts/dist/request-verification.js';

/** 最小展示夹具不模拟浏览器；仅验证已给定事实的汇总口径。 */
function member(verdicts, status = 'COMPLETED') {
  return {
    criteria: verdicts.map((_, i) => ({ criterionId: `c${i}` })),
    arms: [
      {
        executionMode: 'jev',
        result: {
          status,
          reportStatus: verdicts.every((value) => value === 'PASSED')
            ? 'PASSED'
            : 'INCONCLUSIVE',
          result: {
            criteria: verdicts.flatMap((verdict, i) =>
              verdict ? [{ criterionId: `c${i}`, verdict }] : [],
            ),
          },
        },
      },
    ],
  };
}
// 范围：成功、失败、部分失败和未知的业务区分；不验证输入报告的真实性。
test('验证状态不把执行结束、缺失或未验收当成成功', () => {
  for (const [verdicts, status] of [
    [['PASSED'], 'success'],
    [['FAILED'], 'failure'],
    [['PASSED', 'FAILED'], 'partial'],
    [['PASSED', null], 'unknown'],
    [['SKIPPED'], 'unknown'],
    [[], 'unknown'],
  ])
    assert.equal(requestCaseVerification(member(verdicts)).status, status);
  assert.equal(
    requestCaseVerification(member(['FAILED'], 'RUNNING')).status,
    'pending',
  );
  const blocked = member(['PASSED']);
  blocked.arms[0].result.reportStatus = 'INCONCLUSIVE';
  assert.equal(requestCaseVerification(blocked).status, 'unknown');
  const noReport = member(['PASSED']);
  noReport.arms[0].result.reportStatus = null;
  noReport.arms[0].result.steps = [
    { criteria: noReport.arms[0].result.result.criteria },
  ];
  noReport.arms[0].result.result = null;
  assert.equal(requestCaseVerification(noReport).status, 'unknown');
});
// 范围：请求按 case 统计，历史双跑和重复记录不会抬高通过数；不覆盖服务端读事务。
test('总体通过数以全部通过的 case 计数', () => {
  const success = member(['PASSED']);
  success.arms.unshift({
    executionMode: 'llm',
    result: {
      status: 'COMPLETED',
      result: { criteria: [{ criterionId: 'c0', verdict: 'FAILED' }] },
    },
  });
  const counts = requestVerification({
    cases: [
      success,
      member(['FAILED']),
      member(['PASSED', 'FAILED']),
      member([null]),
    ],
  });
  assert.deepEqual(counts, {
    success: 1,
    failure: 1,
    partial: 1,
    pending: 0,
    unknown: 1,
    total: 4,
    status: 'partial',
  });
  assert.equal(
    requestVerification({ cases: [member(['FAILED'])] }).status,
    'failure',
  );
  assert.equal(requestVerification({ cases: [] }).status, 'unknown');
  const duplicate = member(['PASSED']);
  duplicate.arms[0].result.result.criteria.push({
    criterionId: 'c0',
    verdict: 'PASSED',
  });
  assert.equal(requestCaseVerification(duplicate).status, 'unknown');
});
