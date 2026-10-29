import type { TaskDetail } from '@proofrun/contracts';

/** 展示计数不改写存档结论；按当前任务验收身份统计。 */
export interface VerificationProgress {
  /** 排除清理后的验证项目总数，相同项目只计一次。 */
  total: number;
  /** 明确通过的项目数。 */
  passed: number;
}

/** 只读取当前任务的合法验收身份，未生成报告时使用已保存的步骤进度。 */
export function criterionResult(task: TaskDetail, id: string) {
  const records = (
    task.report?.criteria ??
    task.stepResults?.flatMap((step) => step.criteria) ??
    []
  ).filter((item) => item.criterionId === id);
  // 历史重复记录不冒充已验证；明确失败仍可用于展示原始依据。
  return (
    records.find((item) => item.verdict === 'FAILED') ??
    (records.length === 1 ? records[0] : undefined)
  );
}

/** 按当前定义去重，清理项、重复记录和未知结果均不能增加业务通过数。 */
export function verificationProgress(task: TaskDetail): VerificationProgress {
  const criteria = new Set(
    task.definition.acceptanceCriteria
      .filter(
        (item) => !task.definition.cleanupStepIds?.includes(item.stepId ?? ''),
      )
      .map((item) => item.id),
  );
  return {
    total: criteria.size,
    passed: [...criteria].filter(
      (id) => criterionResult(task, id)?.verdict === 'PASSED',
    ).length,
  };
}

/** 优先使用执行器记录的耗时；缺失时不以创建到结束的排队时间冒充执行耗时。 */
export function reportDuration(task: TaskDetail): string {
  const elapsed = task.report?.executionDetails?.elapsedMs;
  return elapsed === undefined ? '未记录' : `${(elapsed / 1000).toFixed(1)} 秒`;
}
