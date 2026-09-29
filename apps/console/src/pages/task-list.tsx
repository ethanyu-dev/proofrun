import { useState, type FormEvent } from 'react';
import type { TaskList } from '@proofrun/contracts';
import { TaskRerun } from '../components/task-rerun';
import { ApiClient } from '../api';
import { useResource } from '../use-resource';
import {
  Empty,
  ErrorNotice,
  PageHeader,
  RefreshBar,
  Status,
  time,
} from '../components/ui';

/** 状态筛选对应执行生命周期，产品验收结论单独显示。 */
const STATES = [
  ['QUEUED', '排队中'],
  ['RUNNING', '执行中'],
  ['COMPLETED', '执行完成'],
  ['CANCELLED', '已取消'],
  ['TIMED_OUT', '已超时'],
  ['ERROR', '执行错误'],
];

/** 报告列表复用任务索引；游标页面保持稳定，返回首页后继续自动刷新。 */
export function TaskListPage({
  api,
  reports = false,
}: {
  api: ApiClient;
  reports?: boolean;
}) {
  const [state, setState] = useState('');
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const params = new URLSearchParams({ limit: '25' });
  if (state) params.set('state', state);
  if (search) params.set('q', search);
  if (reports) params.set('reportOnly', 'true');
  const cursor = cursors.at(-1);
  if (cursor) params.set('cursor', cursor);
  const resource = useResource<TaskList>(
    api,
    `/v1/tasks?${params}`,
    cursors.length === 1,
  );
  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setSearch(draft.trim());
    setCursors([null]);
  };
  return (
    <>
      <PageHeader
        title={reports ? '证据报告' : '验证任务'}
        description={
          reports
            ? '按验收项查看结论，沿证据追溯每一次验证。'
            : '接收已定义的任务，跟进执行进度与验收结果。'
        }
      >
        <a className="button button-primary" href="#/tasks/new">
          提交任务 <span aria-hidden="true">↗</span>
        </a>
      </PageHeader>
      <div className="toolbar">
        <form className="search-form" onSubmit={submitSearch}>
          <label className="sr-only" htmlFor="task-search">
            搜索任务
          </label>
          <input
            id="task-search"
            value={draft}
            maxLength={160}
            placeholder="搜索任务 ID 或目标"
            onChange={(event) => setDraft(event.target.value)}
          />
          <button className="button button-secondary" type="submit">
            搜索
          </button>
        </form>
        <label className="filter-label">
          执行状态
          <select
            value={state}
            onChange={(event) => {
              setState(event.target.value);
              setCursors([null]);
            }}
          >
            <option value="">全部状态</option>
            {STATES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <RefreshBar {...resource} />
      <ErrorNotice message={resource.error} />
      {!resource.data ? (
        <Empty title={resource.loading ? '正在读取任务…' : '任务读取失败'}>
          {resource.loading ? undefined : '连接恢复后可刷新重试。'}
        </Empty>
      ) : resource.data.tasks.length === 0 ? (
        <Empty title={reports ? '暂无匹配的报告' : '暂无匹配的任务'}>
          {search || state
            ? '请调整搜索条件。'
            : reports
              ? '完成验收后，报告将在这里显示。'
              : '提交上层 Agent 已定义的任务后，可在这里跟进执行。'}
        </Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <caption className="sr-only">
              {reports ? '报告列表' : '任务列表'}
            </caption>
            <thead>
              <tr>
                <th>验证目标</th>
                <th>节点池</th>
                <th>执行状态</th>
                <th>验收结论</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {resource.data.tasks.map((task) => (
                <tr key={task.id}>
                  <td className="task-cell">
                    <a
                      className="task-link"
                      href={`#/tasks/${encodeURIComponent(task.id)}`}
                    >
                      {task.objective}
                    </a>
                    <span className="mono muted id-text">{task.id}</span>
                  </td>
                  <td>{task.node_pool}</td>
                  <td>
                    <Status
                      value={
                        task.execution_disposition === 'BLOCKED'
                          ? 'BLOCKED'
                          : task.state
                      }
                    />
                  </td>
                  <td>
                    <Status value={task.verdict} />
                  </td>
                  <td className="date-cell">{time(task.created_at)}</td>
                  <td>
                    <TaskRerun api={api} id={task.id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pagination">
        <span>
          第 {cursors.length} 页
          {cursors.length > 1 ? ' · 返回第一页查看最新任务' : ''}
        </span>
        <div>
          <button
            className="button button-secondary"
            disabled={cursors.length === 1 || resource.loading}
            onClick={() => setCursors((values) => values.slice(0, -1))}
          >
            上一页
          </button>
          <button
            className="button button-secondary"
            disabled={
              !resource.data?.nextCursor || resource.loading || !!resource.error
            }
            onClick={() => {
              if (resource.data?.nextCursor)
                setCursors((values) => [...values, resource.data!.nextCursor]);
            }}
          >
            下一页
          </button>
        </div>
      </div>
    </>
  );
}
