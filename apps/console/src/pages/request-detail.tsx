import { RequestReportContent } from '../components/request-report-content';
import type { RequestResultV2 } from '@proofrun/contracts';
import type { ApiClient } from '../api';
import { useResource } from '../use-resource';
import { Empty, ErrorNotice, RefreshBar, time } from '../components/ui';
import { RequestCases } from '../components/request-cases';
import { RequestExport } from '../components/request-export';
import { RequestRerun } from '../components/request-rerun';

/** 请求详情用紧凑标题和操作栏承载溯源、导航与刷新，结果保持直接展开。 */
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
    <div className="request-detail-page">
      <header className="request-detail-header">
        <div className="request-detail-title">
          <h1>{value?.title ?? (reports ? '测试报告' : '验证请求')}</h1>
          <div className="request-detail-meta">
            <span className="mono">{id}</span>
            {value && <span>创建于 {time(value.createdAt)}</span>}
            {value?.sourceRequestId && (
              <span>
                重跑来源：
                <a
                  href={`#/requests/${encodeURIComponent(value.sourceRequestId)}`}
                >
                  {value.sourceRequestId}
                </a>
              </span>
            )}
          </div>
        </div>
        <div className="request-detail-actions">
          <a
            className="request-detail-link"
            href={reports ? '#/reports' : '#/tasks'}
          >
            返回{reports ? '报告' : '任务'}
          </a>
          {value && <RequestExport value={value} />}
          {value && <RequestRerun key={id} api={api} value={value} />}
        </div>
      </header>
      <div className="request-detail-toolbar">
        <nav className="request-detail-tabs" aria-label="请求内容">
          <a
            aria-current={!reports ? 'page' : undefined}
            href={`#/requests/${encodeURIComponent(id)}`}
          >
            总览与验证目标
          </a>
          <a
            aria-current={reports ? 'page' : undefined}
            href={`#/request-reports/${encodeURIComponent(id)}`}
          >
            测试报告
          </a>
        </nav>
        <RefreshBar {...resource} />
      </div>
      <ErrorNotice message={resource.error} />
      {!value ? (
        <Empty title={resource.loading ? '正在读取请求…' : '请求读取失败'} />
      ) : (
        <>
          {reports && <RequestReportContent key={id} api={api} value={value} />}
          <h2 className="request-section-heading">
            {reports ? 'case 验证结果' : '关联 case 与验证目标'}
            <span>{value.caseCount} 个 case</span>
          </h2>
          <RequestCases api={api} value={value} />
        </>
      )}
    </div>
  );
}
