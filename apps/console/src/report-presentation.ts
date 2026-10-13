import type { TaskDetail } from '@proofrun/contracts';

/** 展示计数不改写存档结论；双跑按同一验收身份取任一模式通过的结果。 */
export interface VerificationProgress {
  /** 排除清理后的验证项目总数，两种模式的相同项目只计一次。 */
  total: number;
  /** 至少一种模式明确通过的项目数。 */
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

/** 按定义身份合并覆盖，清理项和未知结果均不能增加业务通过数。 */
export function verificationProgress(
  tasks: readonly TaskDetail[],
): VerificationProgress {
  const outcomes = new Map<string, boolean>();
  for (const task of tasks) {
    for (const item of task.definition.acceptanceCriteria) {
      if (task.definition.cleanupStepIds?.includes(item.stepId ?? '')) continue;
      outcomes.set(
        item.id,
        (outcomes.get(item.id) ?? false) ||
          criterionResult(task, item.id)?.verdict === 'PASSED',
      );
    }
  }
  return {
    total: outcomes.size,
    passed: [...outcomes.values()].filter(Boolean).length,
  };
}

/** 双跑模式由持久关联确定，旧单组定义沿用 LLM 默认值。 */
export function reportMode(task: TaskDetail): 'llm' | 'jev' {
  return (
    task.definition.comparison?.arm ??
    (task.definition.executionMode === 'jev' ? 'jev' : 'llm')
  );
}

/** 优先使用执行器记录的耗时；缺失时不以创建到结束的排队时间冒充执行耗时。 */
export function reportDuration(task: TaskDetail): string {
  const elapsed = task.report?.executionDetails?.elapsedMs;
  return elapsed === undefined ? '未记录' : `${(elapsed / 1000).toFixed(1)} 秒`;
}
