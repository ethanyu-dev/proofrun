import type { TaskDetail } from '@proofrun/contracts';
import type { VerificationProgress } from '../report-presentation';

/** 整体只呈现通过数与定义总数，不在展示层推导成功或失败标签。 */
export function ReportProgress({
  counts,
}: {
  counts: VerificationProgress | null | undefined;
}) {
  return (
    <span
      className="report-progress"
      aria-label={
        counts
          ? `通过 ${counts.passed} 项，共 ${counts.total} 项`
          : '尚无验证统计'
      }
    >
      {counts ? `${counts.passed} / ${counts.total}` : '— / —'}
    </span>
  );
}

/** 勾叉沿用是否证实预期的归类；未验收及证据不足通过提示保留原始含义。 */
export function CriterionStatus({
  value,
}: {
  value:
    | NonNullable<TaskDetail['report']>['criteria'][number]['verdict']
    | undefined;
}) {
  const label = value === 'PASSED' ? '✓' : value ? '×' : '—';
  const reason =
    value === 'PASSED'
      ? '已证实符合预期'
      : value === 'FAILED'
        ? '已证实不符合预期'
        : value === 'INCONCLUSIVE'
          ? '证据不足，未证实符合预期'
          : value === 'SKIPPED'
            ? '未验收，未证实符合预期'
            : '尚无验收记录';
  return (
    <span
      className="criterion-result"
      data-tone={
        value === 'PASSED'
          ? 'success'
          : value === 'FAILED'
            ? 'danger'
            : 'neutral'
      }
      title={reason}
      aria-label={reason}
    >
      {label}
    </span>
  );
}
