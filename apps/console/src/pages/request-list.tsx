import { RequestPreview } from '../components/request-preview';
import { useState, type FormEvent } from 'react';
import type { RequestList } from '@proofrun/contracts';
import type { ApiClient } from '../api';
import { useResource } from '../use-resource';
import {
  Empty,
  ErrorNotice,
  PageHeader,
  RefreshBar,
  time,
} from '../components/ui';
import {
  RequestSummaryView,
  REQUEST_STATE_LABELS,
} from '../components/request-summary';

/** 列表按请求分页；未产出报告的成员也能在报告视图中找到。 */
export function RequestListPage({
  api,
  reports = false,
}: {
  api: ApiClient;
  reports?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [state, setState] = useState('');
  const [reportStatus, setReportStatus] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const params = new URLSearchParams({ limit: '25' });
  if (search) params.set('q', search);
  if (state) params.set('executionStatus', state);
  if (reportStatus) params.set('reportStatus', reportStatus);
  if (cursors.at(-1)) params.set('cursor', cursors.at(-1)!);
  const resource = useResource<RequestList>(
    api,
    `/v2/requests?${params}`,
    cursors.length === 1,
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSearch(draft.trim());
    setCursors([null]);
  };
  const prefix = reports ? 'request-reports' : 'requests';
  const root = reports ? 'reports' : 'tasks';
  return (
    <>
      <PageHeader
        title={reports ? '验证报告' : '验证任务'}
        description="按一次请求查看关联 case、执行进度与验证结论。"
      >
        <a className="button button-primary" href="#/tasks/new">
          提交任务
        </a>
      </PageHeader>
      <p className="request-view-links">
        请求视图 · <a href={`#/${root}/ungrouped`}>未归组任务</a> ·{' '}
        <a href={`#/${root}/executions`}>执行明细</a>
      </p>
      <div className="toolbar">
        <form className="search-form" onSubmit={submit}>
          <input
            aria-label="搜索请求或 case"
            placeholder="请求标题、请求 ID 或 case"
            maxLength={160}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button className="button button-secondary">搜索</button>
        </form>
        <label>
          执行状态{' '}
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setCursors([null]);
            }}
          >
            <option value="">全部</option>
            {Object.entries(REQUEST_STATE_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          最终结论{' '}
          <select
            value={reportStatus}
            onChange={(e) => {
              setReportStatus(e.target.value);
              setCursors([null]);
            }}
          >
            <option value="">全部（含部分结果）</option>
            <option value="PASSED">通过</option>
            <option value="FAILED">未通过</option>
            <option value="INCONCLUSIVE">无法判定</option>
          </select>
        </label>
      </div>
      <RefreshBar {...resource} />
      <ErrorNotice message={resource.error} />
      {!resource.data ? (
        <Empty title={resource.loading ? '正在读取请求…' : '请求读取失败'} />
      ) : !resource.data.requests.length ? (
        <Empty title="暂无匹配请求">旧格式提交可在“未归组任务”查看。</Empty>
      ) : (
        <div className="request-list">
          {resource.data.requests.map((value) => (
            <article className="panel request-list-card" key={value.requestId}>
              <header className="request-card-heading">
                <h2>
                  <a
                    href={`#/${prefix}/${encodeURIComponent(value.requestId)}`}
                  >
                    {value.title}
                  </a>
                </h2>
                <div className="request-card-meta">
                  <span className="mono request-id">{value.requestId}</span>
                  <span>创建于 {time(value.createdAt)}</span>
                </div>
              </header>
              <RequestSummaryView value={value} />
              <RequestPreview api={api} id={value.requestId} />
              <footer className="request-card-footer">
                <a
                  className="button button-secondary"
                  href={`#/${prefix}/${encodeURIComponent(value.requestId)}`}
                >
                  {reports ? '查看汇总报告' : '查看请求与验证目标'}
                </a>
              </footer>
            </article>
          ))}
        </div>
      )}
      <div className="page-actions">
        <button
          className="button button-secondary"
          disabled={cursors.length === 1}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          上一页
        </button>
        <button
          className="button button-secondary"
          disabled={!resource.data?.nextCursor}
          onClick={() => setCursors([...cursors, resource.data!.nextCursor])}
        >
          下一页
        </button>
      </div>
    </>
  );
}
