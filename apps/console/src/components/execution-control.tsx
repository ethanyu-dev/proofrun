import { Button } from './ui/button';
import type { TaskDetail } from '@proofrun/contracts';
import { ApiClient } from '../api';
import { useResource } from '../use-resource';
import { ErrorNotice } from './ui';
import { useId, useState } from 'react';

/** 长原因默认展示三行摘要，全文留在当前待办内展开，不截断原始诊断内容。 */
const COLLAPSIBLE_REASON_LENGTH = 120;

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
  const [expanded, setExpanded] = useState(false);
  const reasonId = useId();
  const collapsible =
    (execution.control_reason?.length ?? 0) > COLLAPSIBLE_REASON_LENGTH;
  if (
    task.state !== 'RUNNING' ||
    execution.state !== 'RUNNING' ||
    !['REQUESTED', 'HUMAN'].includes(execution.control_mode)
  )
    return null;
  return (
    <div className="execution-intervention" aria-label="待处理事项">
      <div className="execution-intervention-heading">
        <strong>
          {execution.control_mode === 'REQUESTED'
            ? '等待执行交接'
            : '需要人工处理'}
        </strong>
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
      {execution.control_reason && (
        <div className="execution-intervention-reason">
          <p
            id={reasonId}
            className="wrap"
            data-collapsed={collapsible && !expanded}
          >
            {execution.control_reason}
          </p>
          {collapsible && (
            <Button
              variant="ghost"
              type="button"
              className="text-button"
              aria-expanded={expanded}
              aria-controls={reasonId}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? '收起说明' : '展开完整说明'}
            </Button>
          )}
        </div>
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
    <div className="execution-intervention-link">
      <ErrorNotice message={link.error} />
      {link.data?.intervention ? (
        <Button asChild variant="default">
          <a
            className="button button-primary button-small"
            href={link.data.intervention.path}
            target="_blank"
            rel="noopener noreferrer"
          >
            去处理 ↗
          </a>
        </Button>
      ) : (
        <Button
          variant="outline"
          className="button button-secondary button-small"
          disabled={link.loading}
          onClick={link.refresh}
        >
          {link.loading ? '正在获取处理入口…' : '重新获取处理入口'}
        </Button>
      )}
    </div>
  );
}
