import { TaskDelete } from '../components/task-delete';
import { useListProgress } from '../use-list-progress';
import { useState, type FormEvent } from 'react';
import type { TaskList } from '@proofrun/contracts';
import { ReportProgress } from '../components/report-status';
import { TaskRerun } from '../components/task-rerun';
import { executionModeLabel } from '../execution-mode';
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
  ['ERROR', '异常结束（含阻塞）'],
];

/** 报告列表复用任务索引；游标页面保持稳定，返回首页后继续自动刷新。 */
export function TaskListPage({
  api,
  reports = false,
  ungrouped = false,
}: {
  api: ApiClient;
  reports?: boolean;
  ungrouped?: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [state, setState] = useState('');
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const params = new URLSearchParams({ limit: '25' });
  if (state) params.set('state', state);
  if (search) params.set('q', search);
  if (reports) params.set('reportOnly', 'true');
  if (ungrouped) params.set('ungrouped', 'true');
  const cursor = cursors.at(-1);
  if (cursor) params.set('cursor', cursor);
  const resource = useResource<TaskList>(
    api,
    `/v1/tasks?${params}`,
    cursors.length === 1,
  );
  const eligible =
    resource.data?.tasks
      .filter((task) => !['QUEUED', 'RUNNING'].includes(task.state))
      .map((task) => task.id) ?? [];
  const chosen = selected.filter((id) => eligible.includes(id));
  const deleted = () => {
    setSelected([]);
    resource.refresh();
  };
  const progress = useListProgress(
    api,
    resource.data,
    cursors.length === 1,
    resource.updatedAt,
  );
  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setSearch(draft.trim());
    setCursors([null]);
  };
  return (
    <>
      <PageHeader
        title={reports ? '验证报告' : '验证任务'}
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
      <p>
        <a href={reports ? '#/reports' : '#/tasks'}>返回请求视图</a> ·{' '}
        {ungrouped ? '未归组任务' : '全部执行明细'}
      </p>
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
      <TaskDelete api={api} ids={chosen} onDeleted={deleted} />
      <RefreshBar {...resource} />
      <ErrorNotice message={resource.error} />
      {progress.error && (
        <p className="report-notice">部分验证统计暂不可用，刷新后重试。</p>
      )}
      {!resource.data ? (
        <Empty
          title={
            resource.loading
              ? reports
                ? '正在读取报告…'
                : '正在读取任务…'
              : reports
                ? '报告读取失败'
                : '任务读取失败'
          }
        >
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
                <th>
                  <input
                    type="checkbox"
                    aria-label="选择本页已结束运行"
                    checked={
                      !!eligible.length && chosen.length === eligible.length
                    }
                    onChange={(e) =>
                      setSelected(e.target.checked ? eligible : [])
                    }
                  />
                </th>
                <th>验证目标</th>
                {reports ? (
                  <>
                    <th>报告结论</th>
                    <th>证据状态</th>
                    <th>验证结束</th>
                  </>
                ) : (
                  <>
                    <th>节点池</th>
                    <th>执行状态</th>
                    <th>验收结论</th>
                    <th>创建时间</th>
                  </>
                )}
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {resource.data.tasks.map((task) => (
                <tr key={task.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`选择运行 ${task.id}`}
                      disabled={!eligible.includes(task.id)}
                      checked={chosen.includes(task.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...chosen, task.id]
                            : chosen.filter((id) => id !== task.id),
                        )
                      }
                    />
                  </td>
                  <td className="task-cell">
                    <a
                      className="task-link"
                      href={`#/${reports ? 'reports' : 'tasks'}/${encodeURIComponent(task.id)}`}
                    >
                      {task.objective}
                    </a>
                    <span className="mono muted id-text">{task.id}</span>
                    {(task.comparison || task.executionMode) && (
                      <span className="muted id-text">
                        {task.comparison
                          ? `双跑 · ${task.comparison.arm === 'jev' ? '实验组 B · JEV + LLM' : '对照组 A · 纯 LLM'}`
                          : executionModeLabel(task.executionMode ?? undefined)}
                      </span>
                    )}
                    {task.parentTaskId && (
                      <span className="muted id-text">
                        清理所属 case：{' '}
                        <a
                          href={`#/tasks/${encodeURIComponent(task.parentTaskId)}`}
                        >
                          {task.parentTaskId}
                        </a>
                      </span>
                    )}
                  </td>
                  {reports ? (
                    <>
                      <td>
                        <ReportProgress counts={progress.counts(task)} />
                      </td>
                      <td>
                        {task.archived_at
                          ? '已清理'
                          : task.evidenceCount
                            ? `${task.evidenceCount} 份证据`
                            : '未附证据'}
                      </td>
                      <td className="date-cell">{time(task.finished_at)}</td>
                    </>
                  ) : (
                    <>
                      <td>{task.node_pool}</td>
                      <td>
                        <Status
                          value={
                            task.executionOutcome?.category ??
                            (task.execution_reason_code ===
                            'ENVIRONMENT_NOT_READY'
                              ? 'ENVIRONMENT_NOT_READY'
                              : task.execution_disposition === 'BLOCKED'
                                ? 'BLOCKED'
                                : task.state)
                          }
                        />
                      </td>
                      <td>
                        <ReportProgress counts={progress.counts(task)} />
                      </td>
                      <td className="date-cell">{time(task.created_at)}</td>
                    </>
                  )}
                  <td className="task-actions-cell">
                    <div className="task-list-actions">
                      <TaskDelete
                        api={api}
                        ids={[task.id]}
                        disabled={!eligible.includes(task.id)}
                        onDeleted={deleted}
                      />
                      <a
                        className="button button-secondary button-small"
                        href={`#/${reports ? 'reports' : 'tasks'}/${encodeURIComponent(task.id)}`}
                      >
                        查看详情
                      </a>
                      {!reports && (
                        <TaskRerun
                          api={api}
                          id={task.id}
                          caseId={task.caseId}
                        />
                      )}
                    </div>
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
