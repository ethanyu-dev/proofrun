import { BlockedEvidence } from './blocked-evidence';
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
  if (task.report?.executionDetails?.reasonCode === 'ENVIRONMENT_NOT_READY')
    return <Status value="ENVIRONMENT_NOT_READY" />;
  return <Status value={task.state} />;
}

/** 单组及对照组共用终态画面选择；清理最后一帧不得覆盖业务阻塞现场。 */
export function TaskPageView({
  api,
  task,
}: {
  api: ApiClient;
  task: TaskDetail;
}) {
  const execution = task.executions[0];
  if (!execution) return null;
  const active =
    task.state === 'RUNNING' &&
    ['STARTING', 'RUNNING'].includes(execution.state);
  const blocked = (task.report?.steps ?? task.stepResults ?? []).filter(
    (step) =>
      !task.definition.cleanupStepIds?.includes(step.stepId) &&
      ['BLOCKED', 'ERROR'].includes(step.status),
  );
  const results = task.report?.steps ?? task.stepResults ?? [];
  const cleanupRunning = results.some(
    (step) =>
      step.status === 'RUNNING' &&
      task.definition.cleanupStepIds?.includes(step.stepId),
  );
  const cleanupStarted = results.some(
    (step) =>
      !!step.startedAt && task.definition.cleanupStepIds?.includes(step.stepId),
  );
  if (!active && blocked.length)
    return (
      <>
        {blocked.map((step) => (
          <BlockedEvidence
            key={step.stepId}
            api={api}
            task={task}
            step={step}
          />
        ))}
      </>
    );
  if (!active && cleanupStarted)
    return (
      <p className="muted">执行已结束。清理截图在「后续清理」中单独展示。</p>
    );
  return (
    <>
      {cleanupRunning && (
        <p className="muted">当前为清理画面，业务阻塞现场另行保留。</p>
      )}
      <LivePage
        key={execution.id}
        api={api}
        execution={execution}
        active={active}
      />
    </>
  );
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
      <TaskPageView api={api} task={task} />
    </section>
  );
}
