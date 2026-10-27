import type { TaskDetail } from '@proofrun/contracts';
import type { ApiClient } from '../api';
import { ReportSummary } from './report-summary';
import { TaskEvidence } from './task-sections';
import { ExecutionOutcomeDetails } from './execution-outcome';
import { TaskRerun } from './task-rerun';

/** 浏览器任务交付正文与证据，不把空验收集合或生命周期结束显示为业务通过。 */
export function BrowserTaskResult({
  api,
  task,
}: {
  api: ApiClient;
  task: TaskDetail;
}) {
  const result = task.report?.browserResult;
  const active = ['QUEUED', 'RUNNING'].includes(task.state);
  const completed =
    task.state === 'COMPLETED' && result?.outcome === 'COMPLETED';
  return (
    <>
      <section className="panel" aria-label="浏览器任务结果">
        <div className="section-heading">
          <h2>
            {active ? '任务结果' : completed ? '任务已完成' : '任务未完成'}
          </h2>
          {!active && <TaskRerun api={api} id={task.id} taskKind="browser" />}
        </div>
        <p className="muted wrap">目标网址：{task.definition.target.url}</p>
        {result || task.report ? (
          <ReportSummary text={result?.output ?? task.report!.summary} />
        ) : (
          <p>
            {active
              ? '任务执行后将在这里展示结果正文和证据。'
              : '本次执行未交付结果，请查看执行原因和过程。'}
          </p>
        )}
        <ExecutionOutcomeDetails outcome={task.executionOutcome} />
      </section>
      {task.report && <TaskEvidence api={api} task={task} />}
    </>
  );
}
