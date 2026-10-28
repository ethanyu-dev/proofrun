import type { RequestResultV2 } from './generated/request-result-v2.js';

/** 展示使用同一执行组；历史双跑优先选 JEV，不混合另一组的通过项。 */
export function requestCaseArm(member: RequestResultV2['cases'][number]) {
  return (
    member.arms.find((arm) => arm.executionMode === 'jev') ?? member.arms[0]
  );
}

/** 业务验证状态独立于执行生命周期；缺失证据不能当成产品失败。 */
export type VerificationStatus =
  'success' | 'failure' | 'partial' | 'pending' | 'unknown';

/** 只统计定义内的业务验收项；重复记录不算通过，明确失败优先保留。 */
export function caseVerificationCounts(
  criterionIds: readonly string[],
  records: readonly { criterionId: string; verdict: string }[],
) {
  const ids = [...new Set(criterionIds)];
  let passed = 0;
  let failed = 0;
  for (const id of ids) {
    const readings = records.filter((record) => record.criterionId === id);
    if (readings.some((record) => record.verdict === 'FAILED')) failed++;
    else if (readings.length === 1 && readings[0]?.verdict === 'PASSED')
      passed++;
  }
  return { total: ids.length, passed, failed };
}

/** 列表与看板共用整体判定；验收项部分通过不等于 Case 整体通过。 */
export function caseVerificationStatus(
  pending: boolean,
  hasReport: boolean,
  reportStatus: string | null | undefined,
  counts: { total: number; passed: number; failed: number },
): VerificationStatus {
  return pending
    ? 'pending'
    : counts.failed
      ? counts.passed
        ? 'partial'
        : 'failure'
      : counts.total > 0 &&
          counts.passed === counts.total &&
          hasReport &&
          reportStatus === 'PASSED'
        ? 'success'
        : 'unknown';
}

/** 按定义逐项核对，重复或缺失记录不计通过，清理结果不影响业务结论。 */
export function requestCaseVerification(
  member: RequestResultV2['cases'][number],
) {
  const arm = requestCaseArm(member);
  const records =
    arm?.result.result?.criteria ??
    arm?.result.steps?.flatMap((step) => step.criteria) ??
    [];
  const counts = caseVerificationCounts(
    member.criteria.map((criterion) => criterion.criterionId),
    records,
  );
  const pending = !arm || ['QUEUED', 'RUNNING'].includes(arm.result.status);
  const status = caseVerificationStatus(
    pending,
    !!arm?.result.result,
    arm?.result.reportStatus,
    counts,
  );
  return { status, ...counts };
}

/** 请求总览以 case 为单位；含部分失败的 case 不算整体通过。 */
export function requestVerification(value: Pick<RequestResultV2, 'cases'>) {
  const counts = { success: 0, failure: 0, partial: 0, pending: 0, unknown: 0 };
  for (const member of value.cases)
    counts[requestCaseVerification(member).status]++;
  const total = value.cases.length;
  const failed = counts.failure + counts.partial;
  const status: VerificationStatus = counts.pending
    ? 'pending'
    : failed
      ? counts.success || counts.partial || counts.unknown
        ? 'partial'
        : 'failure'
      : total > 0 && counts.success === total
        ? 'success'
        : 'unknown';
  return { ...counts, total, status };
}
