import type { TaskDetail } from '@proofrun/contracts';

/** 报告结论与执行状态使用不同文案，null 只表示报告尚未生成。 */
const REPORT_LABELS = {
  PASSED: ['通过', 'success'],
  FAILED: ['未通过', 'danger'],
  INCONCLUSIVE: ['无法判定', 'warning'],
} as const;

/** 所有报告入口展示服务端提供的统一结论，不在浏览器另行推导。 */
export function ReportStatus({ value }: { value: TaskDetail['reportStatus'] }) {
  const [label, tone] = value ? REPORT_LABELS[value] : ['尚未生成', 'neutral'];
  return (
    <span className="status report-status" data-tone={tone}>
      {label}
    </span>
  );
}

/** 未得出结论包含无法判定和未验收；保留细分数字避免把未执行伪装成已验证。 */
export function ReportCounts({
  counts,
}: {
  counts: TaskDetail['criteriaCounts'];
}) {
  if (!counts) return null;
  return (
    <dl className="report-counts" aria-label="验收项统计">
      <div>
        <dt>验收项</dt>
        <dd>{counts.total}</dd>
      </div>
      <div>
        <dt>通过</dt>
        <dd>{counts.passed}</dd>
      </div>
      <div>
        <dt>未通过</dt>
        <dd>{counts.failed}</dd>
      </div>
      <div>
        <dt>无法判定</dt>
        <dd>{counts.inconclusive}</dd>
      </div>
      <div>
        <dt>未验收</dt>
        <dd>{counts.skipped}</dd>
      </div>
    </dl>
  );
}
