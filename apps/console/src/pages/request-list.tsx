import { TaskDelete } from '../components/task-delete';
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
import { REQUEST_STATE_LABELS } from '../request-presentation';

/** 列表按请求分页；未产出报告的成员也能在报告视图中找到。 */
export function RequestListPage({
  api,
  reports = false,
}: {
  api: ApiClient;
  reports?: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [state, setState] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const params = new URLSearchParams({ limit: '25' });
  if (search) params.set('q', search);
  if (state) params.set('executionStatus', state);
  if (cursors.at(-1)) params.set('cursor', cursors.at(-1)!);
  const resource = useResource<RequestList>(
    api,
    `/v2/requests?${params}`,
    cursors.length === 1,
  );
  const eligible =
    resource.data?.requests
      .filter((r) => r.executionStatus === 'FINISHED')
      .map((r) => r.requestId) ?? [];
  const chosen = selected.filter((id) => eligible.includes(id));
  const deleted = () => {
    setSelected([]);
    resource.refresh();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSearch(draft.trim());
    setCursors([null]);
  };
  const prefix = reports ? 'request-reports' : 'requests';
  return (
    <div className="request-list-page">
      <PageHeader
        title={reports ? '验证报告' : '验证任务'}
        description="按一次请求查看关联 case、通过数与当前完成状态。"
      >
        <a className="button button-primary" href="#/tasks/new">
          提交任务
        </a>
      </PageHeader>
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
      </div>
      <div className="page-actions">
        <label>
          <input
            type="checkbox"
            aria-label="选择本页已结束请求"
            checked={!!eligible.length && chosen.length === eligible.length}
            onChange={(e) => setSelected(e.target.checked ? eligible : [])}
          />
          选择本页已结束请求
        </label>
        <TaskDelete api={api} ids={chosen} requests onDeleted={deleted} />
        <a href={reports ? '#/reports/executions' : '#/tasks/executions'}>
          查看全部运行明细
        </a>
      </div>
      <RefreshBar {...resource} />
      <ErrorNotice message={resource.error} />
      {!resource.data ? (
        <Empty title={resource.loading ? '正在读取请求…' : '请求读取失败'} />
      ) : !resource.data.requests.length ? (
        <Empty title="暂无匹配请求">可调整搜索条件，或提交新的验证任务。</Empty>
      ) : (
        <div className="request-list">
          {resource.data.requests.map((value) => (
            <article className="request-list-card" key={value.requestId}>
              <header className="request-card-heading">
                <input
                  type="checkbox"
                  aria-label={`选择请求 ${value.requestId}`}
                  disabled={!eligible.includes(value.requestId)}
                  checked={chosen.includes(value.requestId)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...chosen, value.requestId]
                        : chosen.filter((id) => id !== value.requestId),
                    )
                  }
                />
                <TaskDelete
                  api={api}
                  ids={[value.requestId]}
                  requests
                  disabled={!eligible.includes(value.requestId)}
                  onDeleted={deleted}
                />
                <div className="request-card-title">
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
                </div>
                <a
                  className="request-detail-link"
                  href={`#/${prefix}/${encodeURIComponent(value.requestId)}`}
                >
                  {reports ? '查看报告' : '查看详情'}{' '}
                  <span aria-hidden="true">↗</span>
                </a>
              </header>
              <RequestPreview
                api={api}
                id={value.requestId}
                poll={cursors.length === 1}
                reports={reports}
              />
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
    </div>
  );
}
