import {
  summarizeReport,
  type CaseResultV2,
  type StepResult,
  type VerificationReport,
  type VerificationTask,
} from '@proofrun/contracts';

/** 只读取持久化执行事实；调用方负责查询隔离、可见性和证据访问授权。 */
export interface CaseFacts {
  /** 冻结定义决定步骤顺序、验收范围和历史主运行身份。 */
  definition: VerificationTask;
  /** 任务生命周期只决定未完成步骤的展示，不补造业务结论。 */
  state: CaseResultV2['status'];
  /** 最终报告优先于执行中的步骤快照。 */
  report: VerificationReport | null;
  /** 异常退出时仍保留已交付的证据、部分结论和阻塞现场。 */
  stepResults?: StepResult[] | null;
  /** 排队诊断来自调度器保存的事实。 */
  queueReason?: CaseResultV2['queueReason'];
  /** 执行原因沿用领域投影，不根据步骤展示状态重新归类。 */
  executionOutcome?: CaseResultV2['executionOutcome'] | null;
}

/** 清理可以来自同任务步骤或历史关联，只投影原记录，不新增清理执行。 */
export interface CleanupFacts {
  /** 原始清理任务身份，内联清理与业务任务相同。 */
  taskId: string;
  /** 清理状态独立于业务验收。 */
  status: NonNullable<CaseResultV2['cleanup']>['status'];
  /** 清理报告仍使用所属主运行的证据访问入口。 */
  report: VerificationReport | null;
}

/** 在副本上补齐终态；保留已记录的所有字段，不将异常退出当成证据不存在。 */
function projectSteps(task: CaseFacts): StepResult[] {
  const terminal = !['QUEUED', 'RUNNING'].includes(task.state);
  const recorded = task.report?.steps ?? task.stepResults ?? [];
  return (task.definition.steps ?? []).map((definition) => {
    const saved = recorded.find((step) => step.stepId === definition.stepId);
    const step: StepResult = saved
      ? structuredClone(saved)
      : {
          stepId: definition.stepId!,
          status: 'PENDING',
          summary: '尚未执行',
          evidenceRefs: [],
          criteria: [],
          startedAt: null,
          finishedAt: null,
        };
    if (terminal && step.status === 'RUNNING') {
      step.status = 'ERROR';
      step.summary = '执行已终止，未交付该步骤完成结论';
    } else if (terminal && step.status === 'PENDING') {
      step.status = 'SKIPPED';
      step.summary = '任务已终止，未执行';
    }
    return step;
  });
}

/** 详情与摘要共享报告转换；摘要查询省略的正文和附件不会被补造。 */
function projectReport(
  caseId: string,
  runId: string,
  report: VerificationReport | null,
  publicUrl: string,
): CaseResultV2['result'] {
  return report
    ? {
        outcome:
          report.executionDisposition === 'EXECUTED'
            ? report.verdict!
            : report.executionDisposition,
        summary: report.summary ?? '',
        criteria: report.criteria.map((criterion) => ({
          ...criterion,
          summary: criterion.summary ?? '',
          evidenceRefs: [...(criterion.evidenceRefs ?? [])],
        })),
        evidence: (report.artifacts ?? []).map((artifact) => ({
          id: artifact.id,
          kind: artifact.kind,
          sha256: artifact.sha256,
          url: `${publicUrl}/v2/cases/${encodeURIComponent(caseId)}/evidence/${encodeURIComponent(artifact.id)}?runId=${encodeURIComponent(runId)}`,
        })),
      }
    : null;
}

/** Case 与请求详情共用唯一结果投影；列表摘要不构造步骤和清理详情。 */
export function projectCase(
  caseId: string,
  task: CaseFacts,
  cleanup: CleanupFacts | null,
  publicUrl: string,
  detail = true,
): Omit<CaseResultV2, 'comparison'> {
  const runId =
    task.definition.comparison?.sourceTaskId ?? task.definition.taskId;
  return {
    caseId,
    runId,
    taskId: task.definition.taskId,
    status: task.state,
    queueReason: task.queueReason ?? null,
    ...(task.executionOutcome
      ? { executionOutcome: task.executionOutcome }
      : {}),
    ...summarizeReport(
      task.report,
      task.definition.acceptanceCriteria.map((c) => c.id),
      task.definition,
    ),
    result: projectReport(caseId, runId, task.report, publicUrl),
    steps: detail ? projectSteps(task) : [],
    cleanup:
      detail && cleanup
        ? {
            taskId: cleanup.taskId,
            status: cleanup.status,
            result: projectReport(caseId, runId, cleanup.report, publicUrl),
          }
        : null,
  };
}
