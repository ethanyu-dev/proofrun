import { requestMetrics } from '../reports/request-metrics.js';
import { taskOutcomes } from '../tasks/outcome.js';
import type { PoolClient } from 'pg';
import {
  summarizeReport,
  summarizeRequest,
  summarizeRequestCase,
  type RequestResultV2,
  type RequestMetrics,
  type VerificationTask,
  type VerificationReport,
  type CaseResultV2,
  type StepResult,
} from '@proofrun/contracts';
import { inlineCleanup } from '../cases/inline-cleanup.js';

/** 元数据保持首次提交值；cursor_at 专用于分页精度。 */
export interface RequestRow {
  /** 请求全局身份，与 case 身份使用独立命名空间。 */
  request_id: string;
  /** 首次提交冻结的展示标题。 */
  title: string;
  /** 原始接收时间，不因复用或重提改变。 */
  created_at: Date;
  /** 原子重跑的来源，普通提交为空。 */
  source_request_id: string | null;
  /** 列表查询保留数据库微秒；详情不使用此字段。 */
  cursor_at: string;
  /** 请求级幂等摘要，不写入 case 定义。 */
  definition_hash: string;
}
/** 同一快照内的任务事实，不包含浏览器会话凭据输出。 */
interface ArmRow {
  /** 当前关联归属，同一个 task 可出现在多个请求中。 */
  request_id: string;
  /** 用于跨组对齐业务标准的 case 身份。 */
  case_id: string;
  /** 首次提交的成员顺序，重排重提不覆盖。 */
  position: number;
  /** 接收时创建或复用的事实。 */
  execution_origin: 'created' | 'reused';
  /** 请求重跑的逐成员来源。 */
  source_case_id: string | null;
  /** 实际执行身份，证据与状态都归属于此任务。 */
  task_id: string;
  /** 冻结模式，不依据当前配置推断。 */
  execution_mode: 'llm' | 'jev';
  /** 只用于服务端确定标准范围，不直接返回整个内部定义。 */
  definition: VerificationTask;
  /** 执行生命周期，不直接转换成验收结论。 */
  state: CaseResultV2['status'];
  /** 详情读取存档，列表仅读取判定所需事实。 */
  report: VerificationReport | null;
  /** 无最终报告时展示已持久化进度，不冒充最终判定。 */
  stepResults: StepResult[] | null;
  /** 最近的调度诊断；为空不代表资源可用。 */
  queue_reason: CaseResultV2['queueReason'];
  /** 在同一读取快照内投影的终止或等待原因。 */
  execution_outcome: CaseResultV2['executionOutcome'] | null;
  /** 原执行创建时间，复用成员保持旧值。 */
  created_at: Date;
  /** 证据清理时间，不删除既有业务结论。 */
  archived_at: Date | null;
  /** 历史独立清理保持旧关联，新任务使用内联清理投影。 */
  legacy_cleanup: {
    /** 原清理执行身份。 */
    taskId: string;
    /** 与主任务业务结果独立的清理状态。 */
    status: NonNullable<CaseResultV2['cleanup']>['status'];
    /** 已交付清理报告，尚无报告时为空。 */
    report: VerificationReport | null;
  } | null;
}

/** 详情与持久摘要共用同一事实读取和汇总函数，避免维护两套业务判定。 */
export class RequestProjector {
  constructor(
    /** 仅详情构造公开证据链接；摘要不保留链接或证据正文。 */
    private readonly publicUrl: string,
  ) {}
  /** 只转换已存档事实；证据继续使用认证且校验 case 归属的原入口。 */
  private report(
    caseId: string,
    report: VerificationReport | null,
    runId: string,
  ): CaseResultV2['result'] {
    return report
      ? {
          outcome:
            report.executionDisposition === 'EXECUTED'
              ? report.verdict!
              : report.executionDisposition,
          summary: report.summary ?? '',
          criteria: report.criteria.map((c) => ({
            ...c,
            summary: c.summary ?? '',
            evidenceRefs: c.evidenceRefs ?? [],
          })),
          evidence: (report.artifacts ?? []).map((a) => ({
            id: a.id,
            kind: a.kind,
            sha256: a.sha256,
            url: `${this.publicUrl}/v2/cases/${encodeURIComponent(caseId)}/evidence/${encodeURIComponent(a.id)}?runId=${encodeURIComponent(runId)}`,
          })),
        }
      : null;
  }

  /** 列表只读结论事实；详情才读取完整步骤、摘要和证据引用。 */
  async project(
    client: PoolClient,
    rows: RequestRow[],
    detail: boolean,
  ): Promise<RequestResultV2[]> {
    if (!rows.length) return [];
    const report = detail
      ? 't.report'
      : `CASE WHEN t.report IS NULL THEN NULL ELSE jsonb_build_object(
      'executionDisposition',t.report->'executionDisposition','verdict',t.report->'verdict',
      'steps',(SELECT coalesce(jsonb_agg(jsonb_build_object('stepId',s->'stepId','status',s->'status')),'[]'::jsonb) FROM jsonb_array_elements(t.report->'steps') s),
      'criteria',(SELECT coalesce(jsonb_agg(jsonb_build_object('criterionId',c->'criterionId','verdict',c->'verdict')),'[]'::jsonb) FROM jsonb_array_elements(t.report->'criteria') c)) END`;
    const definition = detail
      ? 't.definition'
      : `jsonb_build_object('taskId',t.id,'objective',t.definition->'objective','steps',t.definition->'steps','cleanupStepIds',t.definition->'cleanupStepIds','acceptanceCriteria',t.definition->'acceptanceCriteria')`;
    const arms = (
      await client.query<ArmRow>(
        `SELECT a.request_id,a.case_id,c.position,c.execution_origin,c.source_case_id,
      a.task_id,a.execution_mode,${definition} AS definition,t.state,${report} AS report,
      ${detail ? 't.step_results' : 'NULL::jsonb'} AS "stepResults",t.queue_reason,
      NULL::jsonb AS execution_outcome,t.created_at,t.archived_at,
      ${detail ? "CASE WHEN legacy.parent_task_id IS NULL THEN NULL ELSE jsonb_build_object('taskId',legacy.task_id,'status',coalesce(clean.state,legacy.state),'report',clean.report) END" : 'NULL::jsonb'} AS legacy_cleanup
      FROM pr_verification_request_arms a JOIN pr_verification_request_cases c USING(request_id,case_id)
      JOIN pr_tasks t ON t.id=a.task_id
      LEFT JOIN pr_case_cleanups legacy ON legacy.parent_task_id=t.id LEFT JOIN pr_tasks clean ON clean.id=legacy.task_id
      WHERE a.request_id=ANY($1::text[]) AND t.deleted_at IS NULL ORDER BY c.position,CASE a.execution_mode WHEN 'llm' THEN 0 ELSE 1 END`,
        [rows.map((r) => r.request_id)],
      )
    ).rows;
    if (detail) {
      const outcomes = await taskOutcomes(
        client,
        arms.map((a) => a.task_id),
      );
      for (const arm of arms)
        arm.execution_outcome = outcomes.get(arm.task_id) ?? null;
    }
    const generatedAt = (
      await client.query<{ at: Date }>('SELECT transaction_timestamp() AS at')
    ).rows[0]!.at.toISOString();
    const metrics = new Map<string, RequestMetrics>();
    if (detail)
      for (const row of rows)
        metrics.set(
          row.request_id,
          await requestMetrics(client, row.request_id, new Date(generatedAt)),
        );
    return rows.map((row) => {
      const groups = new Map<string, ArmRow[]>();
      for (const arm of arms)
        if (arm.request_id === row.request_id)
          groups.set(arm.case_id, [...(groups.get(arm.case_id) ?? []), arm]);
      const cases = [...groups.values()].map((group) => {
        const first = group[0]!;
        const cleanupIds = new Set(first.definition.cleanupStepIds ?? []);
        return summarizeRequestCase({
          caseId: first.case_id,
          title: first.definition.objective,
          executionOrigin: first.execution_origin,
          sourceCaseId: first.source_case_id,
          steps: detail
            ? (first.definition.steps ?? []).map((step) => ({
                stepId: step.stepId!,
                type: step.type,
                description: step.description,
                expected: step.expected,
                cleanup: cleanupIds.has(step.stepId!),
              }))
            : [],
          criteria: first.definition.acceptanceCriteria.filter(
            (c) => !cleanupIds.has(c.stepId ?? ''),
          ),
          arms: group.map((arm) => {
            const cleanup = !detail
              ? null
              : arm.definition.cleanupStepIds !== undefined
                ? inlineCleanup(arm)
                : arm.legacy_cleanup;
            const terminal = !['QUEUED', 'RUNNING'].includes(arm.state);
            const recorded = arm.report?.steps ?? arm.stepResults ?? [];
            const steps: StepResult[] = detail
              ? (arm.definition.steps ?? []).map((step) => {
                  const saved = recorded.find((s) => s.stepId === step.stepId);
                  if (
                    saved &&
                    (!terminal ||
                      !['PENDING', 'RUNNING'].includes(saved.status))
                  )
                    return saved;
                  return {
                    stepId: step.stepId!,
                    status: terminal
                      ? saved?.status === 'RUNNING'
                        ? 'ERROR'
                        : 'SKIPPED'
                      : 'PENDING',
                    summary: terminal ? '执行已结束，该步骤未完成' : '尚未执行',
                    evidenceRefs: [],
                    criteria: [],
                    startedAt: saved?.startedAt ?? null,
                    finishedAt: saved?.finishedAt ?? null,
                  };
                })
              : [];
            return {
              taskId: arm.task_id,
              executionMode: arm.execution_mode,
              createdAt: arm.created_at.toISOString(),
              archivedAt: arm.archived_at?.toISOString() ?? null,
              result: {
                caseId: arm.case_id,
                status: arm.state,
                queueReason: arm.queue_reason ?? null,
                ...(arm.execution_outcome
                  ? { executionOutcome: arm.execution_outcome }
                  : {}),
                ...summarizeReport(
                  arm.report,
                  arm.definition.acceptanceCriteria.map((c) => c.id),
                  arm.definition,
                ),
                result: this.report(
                  arm.case_id,
                  arm.report,
                  arm.definition.comparison?.sourceTaskId ?? arm.task_id,
                ),
                steps,
                cleanup: cleanup
                  ? {
                      taskId: cleanup.taskId,
                      status: cleanup.status,
                      result: this.report(
                        arm.case_id,
                        cleanup.report,
                        arm.definition.comparison?.sourceTaskId ?? arm.task_id,
                      ),
                    }
                  : null,
              },
            };
          }),
        });
      });
      return {
        requestId: row.request_id,
        title: row.title,
        createdAt: row.created_at.toISOString(),
        sourceRequestId: row.source_request_id,
        generatedAt,
        ...(detail ? { metrics: metrics.get(row.request_id)! } : {}),
        ...summarizeRequest(cases),
        cases,
      };
    });
  }
}
