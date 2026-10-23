import { CaseRunHistory } from '../components/case-run-history';
import { RequestReportContent } from '../components/request-report-content';
import type { RequestResultV2 } from '@proofrun/contracts';
import type { ApiClient } from '../api';
import { useResource } from '../use-resource';
import { Empty, ErrorNotice, RefreshBar, time } from '../components/ui';
import { RequestCases } from '../components/request-cases';
import { RequestTaskCases } from '../components/request-task-cases';
import { RequestExport } from '../components/request-export';
import { RequestRerun } from '../components/request-rerun';

/** 任务与报告共享身份和刷新机制，但分别展示执行目标与验收结果。 */
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
          <a
            className="request-detail-link"
            href={`#/${reports ? 'requests' : 'request-reports'}/${encodeURIComponent(id)}`}
          >
            {reports ? '查看任务详情' : '查看验证报告'}
          </a>
          {reports && value && <RequestExport value={value} />}
          {!reports && value && (
            <RequestRerun key={id} api={api} value={value} />
          )}
        </div>
      </header>
      <div className="request-detail-toolbar">
        <span className="request-detail-context">
          {reports ? '验证报告' : '验证任务详情'}
        </span>
        <RefreshBar {...resource} />
      </div>
      <ErrorNotice message={resource.error} />
      {!value ? (
        <Empty title={resource.loading ? '正在读取请求…' : '请求读取失败'} />
      ) : (
        <>
          {reports && <RequestReportContent key={id} api={api} value={value} />}
          {value.cases.map((member) => (
            <CaseRunHistory
              key={member.caseId}
              api={api}
              caseId={member.caseId}
            />
          ))}
          <h2 className="request-section-heading">
            {reports ? 'case 验证结果' : 'case 目标与执行进度'}
            <span>{value.caseCount} 个 case</span>
          </h2>
          {reports ? (
            <RequestCases api={api} value={value} />
          ) : (
            <RequestTaskCases value={value} />
          )}
        </>
      )}
    </div>
  );
}
