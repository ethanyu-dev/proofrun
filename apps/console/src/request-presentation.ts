import type { RequestResultV2 } from '@proofrun/contracts';

/** 请求筛选只表达执行生命周期，不代表业务验收结论。 */
export const REQUEST_STATE_LABELS = {
  QUEUED: '排队中',
  IN_PROGRESS: '执行中',
  FINISHED: '已结束',
};

/** 保留 case 范围，防止同名验收项或证据跨 case 混用。 */
export type RequestCase = RequestResultV2['cases'][number];

/** 历史双跑沿用原 JEV 优先口径；当前单组沿用实际执行，不合并另一组的结果。 */
export function displayedCaseArm(member: RequestCase) {
  return (
    member.arms.find((arm) => arm.executionMode === 'jev') ?? member.arms[0]
  );
}

/** 报告未交付时读取本组已持久化步骤；缺失或重复记录不冒充通过。 */
export function displayedCriterion(member: RequestCase, criterionId: string) {
  const arm = displayedCaseArm(member);
  const records = (
    arm?.result.result?.criteria ??
    arm?.result.steps?.flatMap((step) => step.criteria) ??
    []
  ).filter((item) => item.criterionId === criterionId);
  return records.length === 1 ? records[0] : undefined;
}

/** 只统计定义内的业务验收项；分母不因未执行或未交付报告缩小。 */
export function caseVerificationProgress(member: RequestCase) {
  const ids = [
    ...new Set(member.criteria.map((criterion) => criterion.criterionId)),
  ];
  return {
    total: ids.length,
    passed: ids.filter(
      (id) => displayedCriterion(member, id)?.verdict === 'PASSED',
    ).length,
  };
}
