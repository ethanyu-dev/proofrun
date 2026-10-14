import type { VerificationTask } from './generated/verification-task.js';

/** 新任务使用冻结证据计划，历史任务仍从验收项推导；禁止运行中扩大采集范围。 */
export function taskEvidenceKinds(task: VerificationTask) {
  return (
    task.executionPlan?.evidenceKinds ?? [
      ...new Set(
        task.acceptanceCriteria.flatMap((criterion) => criterion.evidenceKinds),
      ),
    ]
  );
}
