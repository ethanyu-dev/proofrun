import type {
  StepResult,
  VerificationReport,
  VerificationTask,
} from '@proofrun/contracts';

/** 同任务清理只投影已有步骤事实，不生成执行身份、预算或调度记录。 */
export function inlineCleanup(task: {
  definition: VerificationTask;
  state: string;
  report: VerificationReport | null;
  stepResults?: StepResult[] | null;
}) {
  const ids = new Set(task.definition.cleanupStepIds ?? []);
  if (!ids.size) return null;
  const terminal = !['QUEUED', 'RUNNING'].includes(task.state);
  const steps = (task.report?.steps ?? task.stepResults ?? []).filter((step) =>
    ids.has(step.stepId),
  );
  const complete =
    steps.length === ids.size &&
    steps.every((step) => step.status === 'COMPLETED');
  const started = steps.some((step) => step.startedAt !== null);
  const status = complete
    ? ('COMPLETED' as const)
    : steps.some((step) => ['ERROR', 'BLOCKED'].includes(step.status))
      ? ('ERROR' as const)
      : terminal
        ? started
          ? ('ERROR' as const)
          : ('SKIPPED' as const)
        : started
          ? ('RUNNING' as const)
          : ('PENDING' as const);
  const recorded = steps.flatMap((step) => step.criteria);
  const criteria = task.definition.acceptanceCriteria
    .filter((criterion) => ids.has(criterion.stepId ?? ''))
    .map(
      (criterion) =>
        recorded.find((result) => result.criterionId === criterion.id) ?? {
          criterionId: criterion.id,
          verdict: 'SKIPPED' as const,
          summary: '该清理项尚未验收',
          evidenceRefs: [],
        },
    );
  const refs = new Set(
    steps.flatMap((step) => [
      ...step.evidenceRefs,
      ...step.criteria.flatMap((criterion) => criterion.evidenceRefs),
    ]),
  );
  // 清理报告是原任务结果的子集；业务阶段的故障不冒充清理故障。
  const report: VerificationReport | null =
    task.report &&
    status !== 'PENDING' &&
    status !== 'RUNNING' &&
    status !== 'SKIPPED'
      ? {
          ...task.report,
          executionDisposition: complete ? 'EXECUTED' : 'ERROR',
          verdict: complete
            ? criteria.some((criterion) => criterion.verdict === 'FAILED')
              ? 'FAILED'
              : criteria.every((criterion) => criterion.verdict === 'PASSED')
                ? 'PASSED'
                : 'INCONCLUSIVE'
            : null,
          summary: steps.map((step) => step.summary).join('；'),
          steps: steps as NonNullable<VerificationReport['steps']>,
          criteria,
          artifacts: task.report.artifacts.filter((artifact) =>
            refs.has(artifact.id),
          ),
        }
      : null;
  return { taskId: task.definition.taskId, status, report };
}
