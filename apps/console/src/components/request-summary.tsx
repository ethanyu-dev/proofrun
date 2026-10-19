import type { RequestSummary } from '@proofrun/contracts';
import { RequestStatus as Status } from './request-status';

/** 请求生命周期与业务结论分别命名，避免“已结束”被读成“已通过”。 */
export const REQUEST_STATE_LABELS = {
  QUEUED: '排队中',
  IN_PROGRESS: '执行中',
  FINISHED: '已结束',
};
export const REQUEST_PHASE_LABELS = {
  PENDING: '等待结果',
  PARTIAL: '部分结果',
  FINAL: '最终汇总',
};

/** 页面与列表使用服务端同一份计数；不在客户端重算两组结果。 */
export function RequestSummaryView({ value }: { value: RequestSummary }) {
  const counts = value.uniqueCriteriaCounts;
  return (
    <div className="request-summary">
      <div className="request-status-line">
        <span className="request-lifecycle">
          {REQUEST_STATE_LABELS[value.executionStatus]}
        </span>
        <span className="muted">{REQUEST_PHASE_LABELS[value.reportPhase]}</span>
        {value.reportStatus ? (
          <Status value={value.reportStatus} />
        ) : (
          <span>尚未汇总完成</span>
        )}
      </div>
      <dl className="request-metrics">
        <div>
          <dt>关联 case</dt>
          <dd>
            {value.caseCount}
            <small>个</small>
          </dd>
        </div>
        <div>
          <dt>执行次数</dt>
          <dd>
            {value.executionCounts.total}
            <small>次</small>
          </dd>
        </div>
        <div>
          <dt>case 已结束</dt>
          <dd>
            {value.finishedCaseCount}
            <small>/ {value.caseCount}</small>
          </dd>
        </div>
        <div>
          <dt>报告已交付</dt>
          <dd>
            {value.reportCoverage.available}
            <small>/ {value.reportCoverage.expected}</small>
          </dd>
        </div>
      </dl>
      <div className="request-criteria-counts">
        <strong>唯一验收项 {counts.total}</strong>
        <dl>
          <div data-tone="success">
            <dt>通过</dt>
            <dd>{counts.passed}</dd>
          </div>
          <div data-tone="danger">
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
          <div>
            <dt>待完成</dt>
            <dd>{counts.pending}</dd>
          </div>
        </dl>
      </div>
      {value.observedFailureCount > 0 && (
        <p className="report-notice">
          已发现失败 {value.observedFailureCount} 项
          {value.reportPhase !== 'FINAL' ? '，其他执行仍在继续。' : '。'}
        </p>
      )}
      {value.confirmedDisagreementCount > 0 && (
        <p className="report-notice">
          组间结论不同 {value.confirmedDisagreementCount} 项，请沿两组证据复核。
        </p>
      )}
      {value.reportCoverage.missing > 0 && (
        <p className="request-notice">
          缺少 {value.reportCoverage.missing} 份报告
          {value.reportPhase === 'FINAL'
            ? '；已结束但未交付，不能推断通过。'
            : '；尚未交付的结果不计为通过。'}
        </p>
      )}
    </div>
  );
}
