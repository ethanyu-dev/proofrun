import type { TaskDetail } from '@proofrun/contracts';
import { ApiClient } from '../api';
import { ExecutionControl } from './execution-control';
import { LivePage } from './live-page';
import { Status } from './ui';

/** 生命周期保持原值，人工等待另用明确文案呈现；终态不沿用残留的 HUMAN 模式。 */
export function TaskExecutionStatus({ task }: { task: TaskDetail }) {
  const execution = task.executions[0];
  if (task.state === 'RUNNING' && execution?.state === 'RUNNING') {
    if (execution.control_mode === 'REQUESTED')
      return (
        <span className="status" data-tone="warning">
          等待执行交接
        </span>
      );
    if (execution.control_mode === 'HUMAN')
      return (
        <span className="status" data-tone="warning">
          等待人工处理
        </span>
      );
  }
  return <Status value={task.state} />;
}

/** 单组任务与对照组复用只读画面，人工接管入口始终位于画面上方。 */
export function TaskLive({ api, task }: { api: ApiClient; task: TaskDetail }) {
  const execution = task.executions[0];
  if (!execution) return null;
  return (
    <section className="panel task-live" aria-label="浏览器画面">
      <div className="section-heading">
        <h2>浏览器画面</h2>
      </div>
      <ExecutionControl api={api} task={task} execution={execution} />
      <LivePage
        key={execution.id}
        api={api}
        execution={execution}
        active={
          task.state === 'RUNNING' &&
          ['STARTING', 'RUNNING'].includes(execution.state)
        }
      />
    </section>
  );
}
