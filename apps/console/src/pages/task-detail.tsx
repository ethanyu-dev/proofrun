import { BrowserTaskResult } from '../components/browser-task-result';
import { useState } from 'react';
import type { TaskDetail } from '@proofrun/contracts';
import { ApiClient } from '../api';
import { useResource } from '../use-resource';
import { sourceRequestId } from '../task-links';
import { TaskExecutionStatus } from '../components/execution-outcome';
import { StepPlayback } from '../components/step-playback';
import { Button } from '../components/ui/button';
import { Empty, ErrorNotice, PageHeader } from '../components/ui';

/** 浏览器任务聚合操作与交付结果；验证任务继续只展示执行过程。 */
export function TaskDetailPage({ api, id }: { api: ApiClient; id: string }) {
  const resource = useResource<TaskDetail>(
    api,
    `/v1/tasks/${encodeURIComponent(id)}`,
  );
  const task = resource.data;
  const browser = task?.definition.taskKind === 'browser';
  const active = task?.state === 'QUEUED' || task?.state === 'RUNNING';
  const requestId = sourceRequestId();
  return (
    <>
      <PageHeader
        title={
          task?.definition.taskKind === 'browser' ? '浏览器任务' : '执行过程'
        }
        description={task?.definition.objective ?? ''}
      >
        {task && <TaskExecutionStatus task={task} />}
        <Button asChild variant="outline">
          <a
            href={
              requestId
                ? `#/requests/${encodeURIComponent(requestId)}`
                : task?.definition.taskKind === 'browser'
                  ? '#/browser-tasks'
                  : '#/tasks'
            }
          >
            {requestId ? '返回来源请求' : '返回任务'}
          </a>
        </Button>
      </PageHeader>
      <ErrorNotice message={resource.error} />
      {resource.error && (
        <Button variant="outline" onClick={resource.refresh}>
          重新读取任务
        </Button>
      )}
      {task && browser && !active && (
        <BrowserTaskResult api={api} task={task} />
      )}
      {task ? (
        <ExecutionView key={task.id} api={api} task={task} />
      ) : (
        <Empty title={resource.loading ? '正在读取执行…' : '无法读取执行'} />
      )}
      {task && browser && active && <BrowserTaskResult api={api} task={task} />}
    </>
  );
}

/** 多次执行分别回放，切换时清除图片与步骤选择，避免混用不同会话。 */
function ExecutionView({ api, task }: { api: ApiClient; task: TaskDetail }) {
  const [executionId, setExecutionId] = useState<string>();
  const execution =
    task.executions.find((item) => item.id === executionId) ??
    task.executions[0];
  if (!execution)
    return (
      <Empty title={task.state === 'QUEUED' ? '等待开始执行' : '没有执行记录'}>
        浏览器开始执行后将在这里显示实时画面。
      </Empty>
    );
  return (
    <>
      {task.executions.length > 1 && (
        <div className="page-actions" aria-label="选择执行记录">
          {task.executions.map((item, index) => (
            <Button
              key={item.id}
              variant={item.id === execution.id ? 'secondary' : 'ghost'}
              onClick={() => setExecutionId(item.id)}
            >
              执行记录 {task.executions.length - index}
            </Button>
          ))}
        </div>
      )}
      <StepPlayback
        key={execution.id}
        api={api}
        task={task}
        execution={execution}
      />
    </>
  );
}
