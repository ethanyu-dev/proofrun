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

/** 服务端按显式任务类型筛选后分页，避免客户端过滤漏项或混入历史验证。 */
export function BrowserTaskListPage({ api }: { api: ApiClient }) {
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const params = new URLSearchParams({ taskKind: 'browser', limit: '25' });
  if (search) params.set('q', search);
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
    <>
      <PageHeader
        title="浏览器任务"
        description="按目标操作浏览器，查看交付结果和执行证据。"
      >
        <Button asChild>
          <a href="#/browser-tasks/new">提交浏览器任务</a>
        </Button>
      </PageHeader>
      <form className="toolbar" onSubmit={submit}>
        <Input
          aria-label="搜索浏览器任务"
          placeholder="搜索任务目标或 ID"
          maxLength={160}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button variant="outline">搜索</Button>
      </form>
      <RefreshBar {...resource} />
      <ErrorNotice message={resource.error} />
      {!resource.data ? (
        <Empty title={resource.loading ? '正在读取任务…' : '任务读取失败'} />
      ) : !resource.data.tasks.length ? (
        <Empty title="暂无浏览器任务" />
      ) : (
        <div className="request-list">
          {resource.data.tasks.map((task) => (
            <article key={task.id} className="panel">
              <div className="section-heading">
                <h2>
                  <a href={`#/browser-tasks/${encodeURIComponent(task.id)}`}>
                    {task.objective}
                  </a>
                </h2>
                {task.executionOutcome ? (
                  <OutcomeStatus outcome={task.executionOutcome} />
                ) : (
                  <Status value={task.state} />
                )}
              </div>
              <p className="muted wrap">{task.target_url}</p>
              <p className="muted">{time(task.created_at)}</p>
              <a href={`#/browser-tasks/${encodeURIComponent(task.id)}`}>
                查看结果与执行过程
              </a>
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
    </>
  );
}
