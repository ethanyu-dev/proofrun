import type { TaskDetail } from '@proofrun/contracts';
import { ApiClient } from '../api';
import { useResource } from '../use-resource';
import { ErrorNotice } from './ui';

/** 仅在当前执行等待人工处理时挂载入口，终态残留的控制模式不能代表待办。 */
export function ExecutionControl({
  api,
  execution,
  task,
}: {
  api: ApiClient;
  execution: TaskDetail['executions'][number];
  task: TaskDetail;
}) {
  if (
    task.state !== 'RUNNING' ||
    execution.state !== 'RUNNING' ||
    !['REQUESTED', 'HUMAN'].includes(execution.control_mode)
  )
    return null;
  return (
    <div className="execution-intervention" aria-label="待处理事项">
      <strong>
        {execution.control_mode === 'REQUESTED'
          ? '等待执行交接'
          : '需要人工处理'}
      </strong>
      {execution.control_reason && (
        <p className="wrap">{execution.control_reason}</p>
      )}
      {execution.control_mode === 'HUMAN' ? (
        <InterventionLink
          key={`${execution.id}-${execution.control_revision}`}
          api={api}
          executionId={execution.id}
        />
      ) : (
        <span className="muted note">交接完成后可打开处理页</span>
      )}
    </div>
  );
}

/** 链接只在人工已接管时读取；离开待办状态即卸载轮询，不加载操作记录。 */
function InterventionLink({
  api,
  executionId,
}: {
  api: ApiClient;
  executionId: string;
}) {
  const link = useResource<{ intervention: null | { path: string } }>(
    api,
    `/v1/admin/executions/${encodeURIComponent(executionId)}/intervention`,
  );
  return (
    <>
      <ErrorNotice message={link.error} />
      {link.data?.intervention ? (
        <a
          className="button button-primary button-small"
          href={link.data.intervention.path}
          target="_blank"
          rel="noopener noreferrer"
        >
          去处理 ↗
        </a>
      ) : (
        <button
          className="button button-secondary button-small"
          disabled={link.loading}
          onClick={link.refresh}
        >
          {link.loading ? '正在获取处理入口…' : '重新获取处理入口'}
        </button>
      )}
    </>
  );
}
