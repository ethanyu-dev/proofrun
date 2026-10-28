import {
  SelectField,
  SelectItem,
  ALL_FILTER_VALUE,
} from '../components/select-field';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
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
  Status,
  time,
} from '../components/ui';
import { REQUEST_STATE_LABELS } from '../request-presentation';

/** 任务与报告共用请求列表，分别进入执行详情和报告详情。 */
export function RequestListPage({
  api,
  query = '',
}: {
  api: ApiClient;
  query?: string;
}) {
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [state, setState] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const params = new URLSearchParams({ limit: '25' });
  const range = new URLSearchParams(query);
  const startDate = range.get('startDate');
  const endDate = range.get('endDate');
  // 日期筛选来自看板链接，交给服务端校验；搜索、翻页和自动刷新保持同一范围。
  if (startDate !== null) params.set('startDate', startDate);
  if (endDate !== null) params.set('endDate', endDate);
  if (search) params.set('q', search);
  if (state) params.set('executionStatus', state);
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
  return (
    <div className="request-list-page">
      <PageHeader
        title="验证任务"
        description="按一次请求查看关联 Case、验收项通过数与当前完成状态。"
      >
        <Button asChild variant="default">
          <a className="button button-primary" href="#/tasks/new">
            提交任务
          </a>
        </Button>
      </PageHeader>
      {(startDate !== null || endDate !== null) && (
        <p className="muted">
          请求创建日期：{startDate} — {endDate}（北京时间） ·{' '}
          <a href="#/tasks">查看全部任务</a>
        </p>
      )}
      <div className="toolbar">
        <form className="search-form" onSubmit={submit}>
          <Input
            aria-label="搜索任务标题或用例"
            placeholder="搜索任务标题或用例"
            maxLength={160}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button variant="outline" className="button button-secondary">
            搜索
          </Button>
        </form>
        <label>
          执行状态{' '}
          <SelectField
            label="执行状态"
            value={state || ALL_FILTER_VALUE}
            onValueChange={(value) => {
              setState(value === ALL_FILTER_VALUE ? '' : value);
              setCursors([null]);
            }}
          >
            <SelectItem value={ALL_FILTER_VALUE}>全部</SelectItem>
            {Object.entries(REQUEST_STATE_LABELS).map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectField>
        </label>
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
              <RequestPreview
                api={api}
                id={value.requestId}
                poll={cursors.length === 1}
                renderHeader={(detail) => (
                  <header className="request-card-heading">
                    <div className="request-card-title">
                      <div className="request-card-title-line">
                        <h2>
                          <a
                            href={`#/requests/${encodeURIComponent(value.requestId)}`}
                          >
                            {value.title}
                          </a>
                        </h2>
                        {/* 汇总使用服务端请求生命周期；超时和错误仍在所属 case 内展示。 */}
                        <span
                          className="request-execution-summary"
                          aria-label="请求执行状态"
                        >
                          <Status value={(detail ?? value).executionStatus} />
                        </span>
                      </div>
                      <div className="request-card-meta">
                        <span>创建于 {time(value.createdAt)}</span>
                      </div>
                    </div>
                    <div className="request-card-actions">
                      <a
                        className="request-detail-link"
                        href={`#/requests/${encodeURIComponent(value.requestId)}`}
                      >
                        查看详情 <span aria-hidden="true">↗</span>
                      </a>
                      <a
                        className="request-detail-link"
                        href={`#/request-reports/${encodeURIComponent(value.requestId)}`}
                      >
                        验证报告 <span aria-hidden="true">↗</span>
                      </a>
                    </div>
                  </header>
                )}
              />
            </article>
          ))}
        </div>
      )}
      <div className="page-actions">
        <Button
          variant="outline"
          className="button button-secondary"
          disabled={cursors.length === 1}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          上一页
        </Button>
        <Button
          variant="outline"
          className="button button-secondary"
          disabled={!resource.data?.nextCursor}
          onClick={() => setCursors([...cursors, resource.data!.nextCursor])}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}
