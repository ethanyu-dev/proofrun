import { ReportUsage, ReportUsageDetails } from './report-usage';
import type { RequestResultV2 } from '@proofrun/contracts';
import { requestVerification } from '@proofrun/contracts/request-verification';
import {
  VerificationStatusBadge,
  VERIFICATION_LABELS,
} from './verification-status';

/** 顶部按 case 汇总，与下方当前展示执行组保持相同口径。 */
export function RequestReportOverview({ value }: { value: RequestResultV2 }) {
  const counts = requestVerification(value);
  return (
    <section
      className="panel request-report-overview"
      aria-label="测试报告总体汇总"
    >
      <div className="request-report-heading">
        <h2>测试报告总体汇总</h2>
        <VerificationStatusBadge status={counts.status} />
      </div>
      <div className="request-report-summary">
        <div className="request-report-counts">
          <div className="request-report-total">
            <strong>
              {counts.success}
              <span> / {counts.total}</span>
            </strong>
            <span>Case 通过</span>
          </div>
          <dl>
            {(
              ['success', 'failure', 'partial', 'pending', 'unknown'] as const
            ).map((status) => (
              <div
                key={status}
                className={`verification-status verification-status-${status}`}
              >
                <dt>{VERIFICATION_LABELS[status]}</dt>
                <dd>{counts[status]}</dd>
              </div>
            ))}
          </dl>
        </div>
        <ReportUsage metrics={value.metrics} />
      </div>
      <ReportUsageDetails metrics={value.metrics} />
      <p className="muted">
        全部验收项通过才计入 Case
        通过数；部分失败表示已有明确失败且有部分验证通过。未完成或证据不足单独列出。
      </p>
    </section>
  );
}
