import type { TaskDetail } from './generated/task-detail.js';
import type { VerificationReport } from './generated/verification-report.js';

/** 只携带步骤归属；列表无需读取描述、证据正文或完整任务定义。 */
export interface ReportScope {
  cleanupStepIds?: readonly string[];
  steps?: readonly { stepId?: string }[];
  acceptanceCriteria: readonly { id: string; stepId?: string }[];
}

/** 读取投影只依赖结论事实；列表无需读取摘要、证据内容或完整任务。 */
export type ReportFacts = Pick<
  VerificationReport,
  'executionDisposition' | 'verdict'
> & {
  /** 用步骤终态隔离清理故障，缺失步骤记录不能推断业务已完成。 */
  steps?: readonly { stepId: string; status: string }[];
  /** 按验收身份聚合，未知或重复身份不能增加通过数量。 */
  criteria: Pick<
    VerificationReport['criteria'][number],
    'criterionId' | 'verdict'
  >[];
};

/** 统一控制台与公开 API 的报告状态；不修改存档，也不从执行终态推断业务通过。 */
export function summarizeReport(
  report: ReportFacts | null,
  criterionIds: readonly string[],
  scope?: ReportScope,
): Pick<TaskDetail, 'reportStatus' | 'criteriaCounts'> {
  if (!report) return { reportStatus: null, criteriaCounts: null };
  const cleanup = new Set(scope?.cleanupStepIds ?? []);
  const separateCleanup = cleanup.size > 0 && !!scope?.steps?.length;
  const cleanupCriteria = new Set(
    scope?.acceptanceCriteria
      .filter((item) => cleanup.has(item.stepId ?? ''))
      .map((item) => item.id) ?? [],
  );
  const ids = [...new Set(criterionIds)].filter(
    (id) => !cleanupCriteria.has(id),
  );
  const criteriaCounts = {
    total: ids.length,
    passed: 0,
    failed: 0,
    inconclusive: 0,
    skipped: 0,
  };
  for (const id of ids) {
    const results = report.criteria.filter((item) => item.criterionId === id);
    // 重复项存在歧义时只保留明确失败，否则计为无法判定，避免重复通过冒充覆盖。
    const verdict = results.some((item) => item.verdict === 'FAILED')
      ? 'FAILED'
      : results.length > 1
        ? 'INCONCLUSIVE'
        : (results[0]?.verdict ?? 'SKIPPED');
    if (verdict === 'PASSED') criteriaCounts.passed++;
    else if (verdict === 'FAILED') criteriaCounts.failed++;
    else if (verdict === 'INCONCLUSIVE') criteriaCounts.inconclusive++;
    else criteriaCounts.skipped++;
  }
  const business =
    scope?.steps?.filter((step) => !cleanup.has(step.stepId ?? '')) ?? [];
  const executionComplete = separateCleanup
    ? business.length > 0 &&
      business.every((step) => {
        const records =
          report.steps?.filter((item) => item.stepId === step.stepId) ?? [];
        return records.length === 1 && records[0]!.status === 'COMPLETED';
      })
    : report.executionDisposition === 'EXECUTED' && report.verdict === 'PASSED';
  return {
    // 部分执行已经证实的失败不被后续阻塞掩盖；零验收项的清理任务不产生产品通过结论。
    reportStatus:
      criteriaCounts.failed > 0 ||
      (!separateCleanup && report.verdict === 'FAILED')
        ? 'FAILED'
        : criteriaCounts.total > 0 &&
            criteriaCounts.passed === criteriaCounts.total &&
            executionComplete
          ? 'PASSED'
          : 'INCONCLUSIVE',
    criteriaCounts,
  };
}
