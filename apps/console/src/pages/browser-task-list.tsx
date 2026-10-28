import { useState, type FormEvent } from 'react';
import type { TaskList } from '@proofrun/contracts';
import type { ApiClient } from '../api';
import { useResource } from '../use-resource';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  Empty,
  ErrorNotice,
  PageHeader,
  RefreshBar,
  Status,
  time,
} from '../components/ui';
import { OutcomeStatus } from '../components/execution-outcome';
import { BrowserTaskDelete } from '../components/browser-task-delete';
import {
  ALL_FILTER_VALUE,
  SelectField,
  SelectItem,
} from '../components/select-field';

/** 筛选对应任务生命周期；已结束包含完成或受阻，不等同于目标达成。 */
const BROWSER_TASK_STATES = {
  QUEUED: '排队中',
  RUNNING: '执行中',
  COMPLETED: '已结束',
  CANCELLED: '已取消',
  TIMED_OUT: '已超时',
  ERROR: '执行错误',
};

/** 服务端按显式任务类型筛选后分页，避免客户端过滤漏项或混入历史验证。 */
export function BrowserTaskListPage({ api }: { api: ApiClient }) {
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [state, setState] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const params = new URLSearchParams({ taskKind: 'browser', limit: '25' });
  if (search) params.set('q', search);
  if (state) params.set('state', state);
  if (cursors.at(-1)) params.set('cursor', cursors.at(-1)!);
  const resource = useResource<TaskList>(
    api,
    `/v1/tasks?${params}`,
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
        title="浏览器任务"
        description="按目标操作浏览器，查看交付结果和执行证据。"
      >
        <Button asChild>
          <a className="button button-primary" href="#/browser-tasks/new">
            提交浏览器任务
          </a>
        </Button>
      </PageHeader>
      <div className="toolbar">
        <form className="search-form" onSubmit={submit}>
          <Input
            aria-label="搜索浏览器任务"
            placeholder="搜索任务目标或 ID"
            maxLength={160}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button variant="outline">搜索</Button>
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
            {Object.entries(BROWSER_TASK_STATES).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectField>
        </label>
      </div>
      <RefreshBar {...resource} />
      <ErrorNotice message={resource.error} />
      {!resource.data ? (
        <Empty title={resource.loading ? '正在读取任务…' : '任务读取失败'} />
      ) : !resource.data.tasks.length ? (
        <Empty title="暂无匹配的浏览器任务">
          可调整筛选条件，或提交新的浏览器任务。
        </Empty>
      ) : (
        <div className="request-list">
          {resource.data.tasks.map((task) => (
            <article key={task.id} className="request-list-card">
              <header className="request-card-heading">
                <div className="request-card-title">
                  <div className="request-card-title-line">
                    <h2>
                      <a
                        href={`#/browser-tasks/${encodeURIComponent(task.id)}`}
                      >
                        {task.objective}
                      </a>
                    </h2>
                    {task.executionOutcome ? (
                      <OutcomeStatus outcome={task.executionOutcome} />
                    ) : (
                      <Status
                        value={
                          task.state === 'COMPLETED' ? '已结束' : task.state
                        }
                      />
                    )}
                  </div>
                  <div className="request-card-meta">
                    <span className="wrap">{task.target_url}</span>
                    <span>创建于 {time(task.created_at)}</span>
                  </div>
                </div>
                <div className="request-card-actions">
                  <BrowserTaskDelete
                    api={api}
                    task={task}
                    onDeleted={() => {
                      // 删除后回到首屏，避免当前游标页最后一项消失后留下空页。
                      if (cursors.length > 1) setCursors([null]);
                      else resource.refresh();
                    }}
                  />
                  <a
                    className="request-detail-link"
                    href={`#/browser-tasks/${encodeURIComponent(task.id)}`}
                  >
                    查看详情 <span aria-hidden="true">↗</span>
                  </a>
                  {task.state === 'RUNNING' && (
                    <a
                      className="request-detail-link"
                      href={`#/browser-tasks/${encodeURIComponent(task.id)}?view=live`}
                    >
                      实时画面 <span aria-hidden="true">↗</span>
                    </a>
                  )}
                </div>
              </header>
            </article>
          ))}
        </div>
      )}
      <div className="page-actions">
        <Button
          variant="outline"
          disabled={cursors.length === 1 || resource.loading}
          onClick={() => setCursors((items) => items.slice(0, -1))}
        >
          上一页
        </Button>
        <Button
          variant="outline"
          disabled={!resource.data?.nextCursor || resource.loading}
          onClick={() =>
            setCursors((items) => [...items, resource.data!.nextCursor])
          }
        >
          下一页
        </Button>
      </div>
    </div>
  );
}
