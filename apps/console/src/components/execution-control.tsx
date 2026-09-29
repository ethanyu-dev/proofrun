import { useState } from 'react';
import type { ExecutionActivity, TaskDetail } from '@proofrun/contracts';
import { ApiClient, errorMessage } from '../api';
import { useResource } from '../use-resource';
import { ErrorNotice, time } from './ui';

/** 控制台只发起介入和查看摘要；实际处理在不含平台导航的专属页面完成。 */
export function ExecutionControl({
  api,
  execution,
  task,
  refresh,
}: {
  api: ApiClient;
  execution: TaskDetail['executions'][number];
  task: TaskDetail;
  refresh: () => void;
}) {
  const base = `/v1/admin/executions/${encodeURIComponent(execution.id)}`;
  const activity = useResource<ExecutionActivity>(api, `${base}/activity`);
  const link = useResource<{
    intervention: null | { path: string; expiresAt: string };
  }>(api, `${base}/intervention`);
  const [reason, setReason] = useState('请处理当前页面的问题，然后继续验证');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const running = task.state === 'RUNNING' && execution.state === 'RUNNING';
  return (
    <section className="panel" aria-label="人工介入与操作记录">
      <div className="section-heading">
        <h2>人工介入与操作记录</h2>
        <span className="status">
          {execution.control_mode === 'AUTO'
            ? '自动执行'
            : execution.control_mode === 'REQUESTED'
              ? '等待 Agent 交接'
              : '等待人工处理'}
        </span>
      </div>
      <ErrorNotice message={error || link.error || activity.error} />
      {running &&
        task.definition.environment.allowIntervention &&
        execution.control_mode === 'AUTO' && (
          <form
            className="control-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (pending) return;
              setPending(true);
              setError('');
              try {
                await api.json(
                  `${base}/intervene`,
                  new AbortController().signal,
                  {
                    type: 'execution.intervene',
                    reason,
                    items: [reason],
                    controlRevision: execution.control_revision,
                  },
                );
                refresh();
                link.refresh();
                activity.refresh();
              } catch (error) {
                setError(errorMessage(error));
              } finally {
                setPending(false);
              }
            }}
          >
            <label>
              需要人工处理的事项
              <input
                value={reason}
                required
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <button className="button button-secondary" disabled={pending}>
              请求人工介入
            </button>
          </form>
        )}
      {link.data?.intervention && (
        <div className="page-actions">
          <a
            className="button button-primary"
            href={link.data.intervention.path}
            target="_blank"
            rel="noopener noreferrer"
          >
            打开独立处理页 ↗
          </a>
          <button
            className="button button-secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  new URL(link.data!.intervention!.path, location.origin).href,
                );
              } catch {
                setError('无法复制链接，请打开处理页后复制地址');
              }
            }}
          >
            复制处理链接
          </button>
          <p className="muted note">
            持有链接的人可处理本次任务，无需平台登录。有效至{' '}
            {time(link.data.intervention.expiresAt)}，完成后失效。
          </p>
        </div>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>来源</th>
              <th>操作</th>
              <th>结果</th>
              <th>效果</th>
            </tr>
          </thead>
          <tbody>
            {activity.data?.commands.map((item) => (
              <tr key={item.id}>
                <td>{time(item.created_at)}</td>
                <td>{item.actor === 'HUMAN' ? '人工' : '系统'}</td>
                <td>{item.action || item.kind}</td>
                <td>{item.status || '处理中'}</td>
                <td>{item.effect || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
