import type { RequestResultV2 } from '@proofrun/contracts';
import type { ApiClient } from '../api';
import { useResource } from '../use-resource';
import {
  Empty,
  ErrorNotice,
  PageHeader,
  RefreshBar,
  time,
} from '../components/ui';
import { RequestSummaryView } from '../components/request-summary';
import { RequestCases } from '../components/request-cases';
import { RequestExport } from '../components/request-export';
import { RequestRerun } from '../components/request-rerun';

/** 请求总览与汇总报告共用服务端快照；原始执行报告仍有稳定入口。 */
export function RequestDetailPage({
  api,
  id,
  reports = false,
}: {
  api: ApiClient;
  id: string;
  reports?: boolean;
}) {
  const resource = useResource<RequestResultV2>(
    api,
    `/v2/requests/${encodeURIComponent(id)}${reports ? '/report' : ''}`,
  );
  const value = resource.data;
  return (
    <>
      <PageHeader
        title={value?.title ?? (reports ? '请求汇总报告' : '验证请求')}
        description={id}
      >
        <a
          className="button button-secondary"
          href={reports ? '#/reports' : '#/tasks'}
        >
          返回{reports ? '报告' : '任务'}
        </a>
        {value && <RequestExport value={value} />}
      </PageHeader>
      <nav className="page-actions" aria-label="请求内容">
        <a
          className="button button-secondary"
          aria-current={!reports ? 'page' : undefined}
          href={`#/requests/${encodeURIComponent(id)}`}
        >
          总览与验证目标
        </a>
        <a
          className="button button-secondary"
          aria-current={reports ? 'page' : undefined}
          href={`#/request-reports/${encodeURIComponent(id)}`}
        >
          汇总报告
        </a>
      </nav>
      <RefreshBar {...resource} />
      <ErrorNotice message={resource.error} />
      {!value ? (
        <Empty title={resource.loading ? '正在读取请求…' : '请求读取失败'} />
      ) : (
        <>
          <section className="panel request-overview">
            <RequestSummaryView value={value} />
            <p className="muted request-snapshot">
              创建于 {time(value.createdAt)} · 快照 {time(value.generatedAt)} ·
              汇总版本 {value.aggregationVersion}
            </p>
            {value.sourceRequestId && (
              <p>
                重跑来源：
                <a
                  href={`#/requests/${encodeURIComponent(value.sourceRequestId)}`}
                >
                  {value.sourceRequestId}
                </a>
              </p>
            )}
            <RequestRerun key={id} api={api} value={value} />
          </section>
          {reports && (
            <section className="panel request-mode-summary">
              <h2>按执行模式汇总</h2>
              <div className="request-arms">
                {value.byExecutionMode.map((mode) => (
                  <section className="request-arm" key={mode.executionMode}>
                    <h3>
                      {mode.executionMode === 'llm' ? 'LLM' : 'JEV + LLM'}
                    </h3>
                    <p>
                      覆盖 {mode.caseCount} 个 case · 缺少报告{' '}
                      {mode.missingReportCount}
                    </p>
                    <p>
                      已交付报告的验收项 {mode.criteriaCounts.total} · 通过{' '}
                      {mode.criteriaCounts.passed} · 未通过{' '}
                      {mode.criteriaCounts.failed} · 无法判定{' '}
                      {mode.criteriaCounts.inconclusive} · 未验收{' '}
                      {mode.criteriaCounts.skipped}
                    </p>
                  </section>
                ))}
              </div>
            </section>
          )}
          <h2 className="request-section-heading">
            {reports ? 'case 结论与证据对照' : '关联 case 与验证目标'}
            <span>{value.caseCount} 个 case</span>
          </h2>
          <RequestCases api={api} value={value} />
        </>
      )}
    </>
  );
}
