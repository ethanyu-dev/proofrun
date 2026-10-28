import type { PoolClient } from 'pg';
import type {
  VerificationTask,
  VerificationReport,
  StepResult,
  RequestResultV2,
  McpTaskCall,
  QueueReason,
} from '@proofrun/contracts';
import { ApiError, canonical, digest } from '../../domain.js';
import type { Database } from '../../db.js';
import type { RequestReader } from '../requests/reader.js';
import { projectCase } from '../cases/projection.js';
import { inlineCleanup } from '../cases/inline-cleanup.js';
import { taskOutcomes } from '../tasks/outcome.js';
import { requireOwned } from './ledger.js';

/** 单页大小约束覆盖条目正文，摘要另以固定上限投影，避免整请求灌入模型。 */
const PAGE_BYTES = 96 * 1024;
const SUMMARY_CHARS = 500;
type Paging = { cursor?: string; limit?: number };
/** 原始事实只在服务内部使用，不把任务环境和身份材料返回公共调用方。 */
export interface PublicTaskRow {
  /** 首次入队冻结的定义；公共响应不得直接序列化。 */
  definition: VerificationTask;
  /** 执行生命周期独立于验收结论和浏览器关闭状态。 */
  state:
    'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'TIMED_OUT' | 'ERROR';
  report: VerificationReport | null;
  /** 冻结执行主体，不能用 llm 兼容字段推断来源。 */
  executorKind: 'builtin' | 'external';
  /** 运行中持久化的部分结果，最终报告存在时以最终报告为准。 */
  stepResults: StepResult[] | null;
  /** 复用调度器诊断，不自行预测资源就绪。 */
  queueReason: QueueReason | null;
  /** 所有已创建会话均已确认关闭；尚未创建会话时为 true。 */
  closureVerified: boolean;
}
/** 请求版本只绑定当前成员，不随业务进度或生成时间变化。 */
export function requestRevision(source: RequestResultV2): string {
  return digest(
    canonical(
      source.cases
        .map((item) => [item.caseId, item.arms.map((arm) => arm.taskId)])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ),
  );
}
/** 游标绑定资源和事实快照；报告变化必须重读，禁止拼接不同运行结果。 */
function page(
  rows: Record<string, unknown>[],
  scope: string,
  revision: string,
  input: Paging,
  enabled: boolean,
) {
  let offset = 0;
  if (input.cursor) {
    try {
      const cursor = JSON.parse(
        Buffer.from(input.cursor, 'base64url').toString('utf8'),
      );
      if (cursor.scope !== scope || cursor.revision !== revision)
        throw new Error();
      if (
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0 ||
        cursor.offset > rows.length
      )
        throw new Error();
      offset = cursor.offset;
    } catch {
      throw new ApiError(
        409,
        'CURSOR_STALE',
        '游标已过期或不属于当前报告，请重新读取第一页',
      );
    }
  }
  if (!enabled && (input.cursor || input.limit))
    throw new ApiError(400, 'INVALID_QUERY', '摘要视图不接受详情分页');
  const selected: Record<string, unknown>[] = [];
  let bytes = 0;
  if (enabled)
    for (const row of rows.slice(offset, offset + (input.limit ?? 25))) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (selected.length && bytes + size > PAGE_BYTES) break;
      if (size > PAGE_BYTES)
        throw new ApiError(
          503,
          'REPORT_ENTRY_TOO_LARGE',
          '单条报告超出读取上限',
        );
      selected.push(row);
      bytes += size;
    }
  const next = offset + selected.length;
  return {
    criteriaPage: selected,
    nextCursor:
      enabled && next < rows.length
        ? Buffer.from(
            JSON.stringify({ scope, revision, offset: next }),
          ).toString('base64url')
        : null,
    reportRevision: revision,
  };
}
/** 未执行项保留空结论；终态的缺失项明确为 SKIPPED，不推断通过。 */
function criteria(
  task: VerificationTask,
  saved: VerificationReport['criteria'],
  terminal: boolean,
) {
  return task.acceptanceCriteria.map((expected) => {
    const value = saved.find((item) => item.criterionId === expected.id);
    return {
      runId: task.taskId,
      ...(task.caseV2Definition
        ? { caseId: task.caseV2Definition.caseId }
        : {}),
      ...(expected.stepId ? { stepId: expected.stepId } : {}),
      criterionId: expected.id,
      expected: expected.expectedResult,
      verdict: value?.verdict ?? (terminal ? 'SKIPPED' : null),
      summary: value?.summary ?? '',
      evidenceRefs: value?.evidenceRefs ?? [],
    };
  });
}

/** 公开读取复用现有 Case/请求投影，再做有界白名单输出，不改变业务结论。 */
export class PublicViews {
  constructor(
    private readonly db: Database,
    private readonly requests: RequestReader,
    private readonly publicUrl: string,
  ) {}

  /** 读取同一事务中的状态与关闭事实；不存在会话时不存在待释放浏览器。 */
  async task(
    client: PoolClient,
    principal: string,
    runId: string,
  ): Promise<PublicTaskRow> {
    await requireOwned(client, principal, { kind: 'run', id: runId });
    return (
      await client.query<PublicTaskRow>(
        `SELECT t.executor_kind AS "executorKind",t.definition,t.state,t.report,t.step_results AS "stepResults",t.queue_reason AS "queueReason",
      NOT EXISTS(SELECT 1 FROM pr_executions e JOIN pr_sessions s ON s.execution_id=e.id WHERE e.task_id=t.id AND NOT s.closure_verified) AS "closureVerified"
      FROM pr_tasks t WHERE t.id=$1 AND t.deleted_at IS NULL`,
        [runId],
      )
    ).rows[0]!;
  }

  async run(
    principal: string,
    input: Extract<McpTaskCall, { name: 'verification_get_run' }>['arguments'],
    kind: 'browser' | 'verification',
  ) {
    return this.db.transaction(async (client) => {
      await client.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      const row = await this.task(client, principal, input.runId);
      const task = row.definition;
      if ((task.taskKind ?? 'verification') !== kind)
        throw new ApiError(
          404,
          'RESOURCE_NOT_FOUND',
          '此接入面不提供该任务类型',
        );
      const terminal = !['QUEUED', 'RUNNING'].includes(row.state);
      const cleanup = inlineCleanup(row);
      const projected = projectCase(
        task.caseV2Definition?.caseId ?? '',
        row,
        cleanup,
        this.publicUrl,
      );
      const outcome =
        (await taskOutcomes(client, [input.runId])).get(input.runId) ?? null;
      const saved =
        row.report?.criteria ??
        (row.stepResults ?? []).flatMap((step) => step.criteria);
      const detail = criteria(task, saved, terminal);
      const revision = digest(
        canonical([
          row.state,
          row.report,
          row.stepResults,
          row.queueReason,
          row.closureVerified,
          outcome,
        ]),
      );
      let truncated = false;
      const text = (value: string) => {
        if (value.length > SUMMARY_CHARS) truncated = true;
        return value.slice(0, SUMMARY_CHARS);
      };
      const steps = projected.steps.map((step) => ({
        stepId: step.stepId,
        status: step.status,
        summary: text(step.summary),
        evidenceRefs: step.evidenceRefs,
        ...(step.phase ? { phase: step.phase } : {}),
        ...(step.reasonCode ? { reasonCode: step.reasonCode } : {}),
      }));
      const data = {
        runId: input.runId,
        ...(task.caseV2Definition
          ? { caseId: task.caseV2Definition.caseId }
          : {}),
        taskKind: kind,
        executor: { kind: row.executorKind },
        status: row.state,
        reportPhase: terminal ? 'FINAL' : saved.length ? 'PARTIAL' : 'PENDING',
        reportStatus: kind === 'browser' ? null : projected.reportStatus,
        criteriaCounts: kind === 'browser' ? null : projected.criteriaCounts,
        summary: text(row.report?.summary ?? ''),
        browserResult: row.report?.browserResult ?? null,
        steps,
        cleanup: cleanup
          ? {
              status: cleanup.status,
              summary: text(cleanup.report?.summary ?? ''),
            }
          : null,
        queueReason: row.queueReason,
        executionOutcome: outcome,
        closureVerified: row.closureVerified,
        ...page(
          detail,
          `run:${input.runId}:${input.view ?? 'summary'}`,
          revision,
          input,
          input.view === 'full',
        ),
        textTruncated: truncated,
      };
      return { kind: 'run', data };
    });
  }

  async request(
    principal: string,
    input: Extract<
      McpTaskCall,
      { name: 'verification_get_request' }
    >['arguments'],
  ): Promise<Record<string, unknown>> {
    return this.db.transaction(async (client) => {
      await client.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      await requireOwned(client, principal, {
        kind: 'request',
        id: input.requestId,
      });
      const source = await this.requests.snapshot(client, input.requestId);
      const detail: Record<string, unknown>[] = [];
      const cases = [];
      for (const member of source.cases) {
        const runId = member.arms[0]!.taskId;
        const row = await this.task(client, principal, runId);
        const result = member.arms[0]!.result;
        cases.push({
          caseId: member.caseId,
          runId,
          status: result.status,
          reportStatus: result.reportStatus,
          criteriaCounts: result.criteriaCounts,
          cleanup: result.cleanup ? { status: result.cleanup.status } : null,
          executionOrigin: member.executionOrigin,
          closureVerified: row.closureVerified,
        });
        detail.push(
          ...criteria(
            row.definition,
            row.report?.criteria ??
              (row.stepResults ?? []).flatMap((step) => step.criteria),
            !['QUEUED', 'RUNNING'].includes(row.state),
          ),
        );
      }
      const { cases: _, title, requestId, ...summary } = source;
      const revision = digest(canonical([cases, detail, summary.reportPhase]));
      return {
        kind: 'request',
        data: {
          requestId,
          title,
          requestRevision: requestRevision(source),
          summary,
          cases,
          ...page(
            detail,
            `request:${requestId}:${input.view ?? 'summary'}`,
            revision,
            input,
            input.view === 'report',
          ),
          textTruncated: false,
        },
      };
    });
  }
}
