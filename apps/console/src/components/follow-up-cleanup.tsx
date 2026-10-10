import type { TaskDetail } from '@proofrun/contracts';
import type { ApiClient } from '../api';
import { CleanupResult } from './cleanup-result';
import { stepStatus } from './step-completion';
import { Status } from './ui';

/** 清理保留独立状态与证据，不进入业务验收列表和最终业务结论。 */
export function FollowUpCleanup({
  api,
  task,
}: {
  api: ApiClient;
  task: TaskDetail;
}) {
  const steps =
    task.definition.steps?.filter((step) =>
      task.definition.cleanupStepIds?.includes(step.stepId!),
    ) ?? [];
  if (!steps.length) return null;
  return (
    <section className="panel" aria-label="后续清理">
      <h2>后续清理</h2>
      <p className="muted">清理结果单独记录，不纳入最终验证判定。</p>
      {steps.map((step) => {
        const result = (task.report?.steps ?? task.stepResults)?.find(
          (item) => item.stepId === step.stepId,
        );
        const status = stepStatus(task, result);
        return (
          <article className="criterion" key={step.stepId}>
            <div className="section-heading">
              <h3>
                {step.stepId} · {step.description}
              </h3>
              <Status value={status === 'SKIPPED' ? '未执行' : status} />
            </div>
            <CleanupResult
              api={api}
              task={task}
              step={step}
              result={result}
              status={status}
            />
          </article>
        );
      })}
    </section>
  );
}
