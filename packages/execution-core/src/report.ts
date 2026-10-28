import type { VerificationReport, VerificationTask } from '@proofrun/contracts';

/** 故障和浏览器任务不产生产品判定；空验收列表的历史聚合语义保持不变。 */
export function reportVerdict(
  disposition: VerificationReport['executionDisposition'],
  criteria: VerificationReport['criteria'],
  browser = false,
): VerificationReport['verdict'] {
  return disposition !== 'EXECUTED' || browser
    ? null
    : criteria.some((item) => item.verdict === 'FAILED')
      ? 'FAILED'
      : criteria.every((item) => item.verdict === 'PASSED')
        ? 'PASSED'
        : 'INCONCLUSIVE';
}

/** 单组报告输入只包含已验证事实；耗时由宿主采样，核心不读取时钟。 */
export interface ExecutionReportInput {
  /** 原运行身份，组级执行也不能创建新的任务身份。 */
  taskId: string;
  /** 浏览器任务没有验收判定，正文与要求证据单独交付。 */
  browser: boolean;
  /** 执行结果与产品逐项判定独立。 */
  disposition: VerificationReport['executionDisposition'];
  summary: string;
  criteria: VerificationReport['criteria'];
  /** 已交付且经过归属检查的证据；要求引用必须落在此集合内。 */
  artifacts: VerificationReport['artifacts'];
  requirementEvidence: string[];
  /** 模型/动作计数来自实际驱动回执。 */
  details: NonNullable<VerificationReport['executionDetails']>;
  reasonCode: string | null;
  elapsedMs: number;
}

/** 报告由平台账本生成，不接受模型整体 verdict，也不伪造缺少的证据。 */
export function buildExecutionReport(
  input: ExecutionReportInput,
): VerificationReport {
  const evidence = new Set(input.artifacts.map((artifact) => artifact.id));
  return {
    protocolVersion: '0.1',
    taskId: input.taskId,
    lifecycle: 'COMPLETED',
    executionDisposition: input.disposition,
    verdict: reportVerdict(input.disposition, input.criteria, input.browser),
    summary: input.summary,
    criteria: input.criteria,
    artifacts: input.artifacts,
    ...(input.browser
      ? {
          browserResult: {
            outcome:
              input.disposition === 'EXECUTED'
                ? ('COMPLETED' as const)
                : ('INCOMPLETE' as const),
            output: input.summary,
            evidenceRefs: [...new Set(input.requirementEvidence)].filter((id) =>
              evidence.has(id),
            ),
          },
        }
      : {}),
    executionDetails: {
      ...input.details,
      commandIds: [...input.details.commandIds],
      reasonCode: input.reasonCode,
      elapsedMs: input.elapsedMs,
    },
  };
}

/** 汇总只读取已经验证的分组结果；清理报告参与用量和证据，不覆盖业务失败原因。 */
export interface ProfileReportInput {
  /** 接收时冻结的任务，决定最终验收项全集。 */
  task: VerificationTask;
  /** 已有分组和清理结果，未执行项显式补为 SKIPPED。 */
  reports: VerificationReport[];
  /** 驱动按业务组优先级选出的失败，取消也可作为失败来源。 */
  failed?:
    | (Pick<VerificationReport, 'executionDisposition' | 'summary'> & {
        executionDetails?: { reasonCode?: string | null };
      })
    | undefined;
  /** 驱动持久化的完整步骤快照。 */
  steps: NonNullable<VerificationReport['steps']>;
  /** 本轮配置的模型标识，不包含供应商地址或凭据。 */
  model: string;
}

/** 无网络、时钟或数据库依赖；相同冻结输入产生相同最终报告。 */
export function aggregateProfileReport({
  task,
  reports,
  failed,
  steps,
  model,
}: ProfileReportInput): VerificationReport {
  const recorded = reports.flatMap((r) => r.criteria);
  const criteria = task.acceptanceCriteria.map(
    (c) =>
      recorded.find((r) => r.criterionId === c.id) ?? {
        criterionId: c.id,
        verdict: 'SKIPPED' as const,
        summary: '该组未执行此验证',
        evidenceRefs: [],
      },
  );
  const artifactMap = new Map(
    reports.flatMap((r) => r.artifacts).map((a) => [a.id, a]),
  );
  return {
    protocolVersion: '0.1',
    taskId: task.taskId,
    lifecycle: 'COMPLETED',
    executionDisposition: failed?.executionDisposition ?? 'EXECUTED',
    verdict: reportVerdict(
      failed?.executionDisposition ?? 'EXECUTED',
      criteria,
    ),
    summary:
      (failed ? `${failed.summary}\n` : '') +
      task
        .profilePlan!.groups.map(
          (g) =>
            `${g.id}：${g.stepIds.map((id) => `${id} ${steps.find((step) => step.stepId === id)!.status}`).join('、')}`,
        )
        .join('\n'),
    criteria,
    steps,
    artifacts: [...artifactMap.values()],
    executionDetails: {
      reasonCode: failed?.executionDetails?.reasonCode ?? null,
      model,
      promptTokens: reports.reduce(
        (n, r) => n + (r.executionDetails?.promptTokens ?? 0),
        0,
      ),
      completionTokens: reports.reduce(
        (n, r) => n + (r.executionDetails?.completionTokens ?? 0),
        0,
      ),
      actions: reports.reduce(
        (n, r) => n + (r.executionDetails?.actions ?? 0),
        0,
      ),
      modelCalls: reports.reduce(
        (n, r) => n + (r.executionDetails?.modelCalls ?? 0),
        0,
      ),
      elapsedMs: reports.reduce(
        (n, r) => Math.max(n, r.executionDetails?.elapsedMs ?? 0),
        0,
      ),
      commandIds: [
        ...new Set(
          reports.flatMap((r) => r.executionDetails?.commandIds ?? []),
        ),
      ],
    },
  };
}
