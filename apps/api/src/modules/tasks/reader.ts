import type { CleanupFacts } from '../cases/projection.js';
import { identitySummary } from '../sessions/summary.js';
import { inlineCleanup } from '../cases/inline-cleanup.js';
import { taskOutcomes } from './outcome.js';
import {
  summarizeReport,
  type ReportFacts,
  type ReportScope,
  type TaskList,
  type TaskSummary,
  type VerificationTask,
  type VerificationReport,
  type StepResult,
  type QueueReason,
} from '@proofrun/contracts';
import { Database } from '../../db.js';
import { ApiError, ID_PATTERN } from '../../domain.js';

/** 查询窗口受限，列表不读取完整任务和报告。 */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const STATES = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'CANCELLED',
  'TIMED_OUT',
  'ERROR',
];
/** 游标保留 PostgreSQL 的微秒精度，防止同毫秒记录跨页丢失。 */
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
/** 搜索按字面值匹配，输入中的百分号、下划线和反斜线不作为 SQL 通配符。 */
const LIKE_ESCAPE = /[\\%_]/g;

/** 游标绑定筛选条件；客户端更换筛选后需要从第一页开始。 */
interface Cursor {
  /** 保留微秒的数据库创建时间。 */
  at: string;
  /** 相同创建时间下的稳定排序键。 */
  id: string;
  /** 绑定搜索与状态筛选，防止跨条件复用游标。 */
  filter: string;
}

/** 统一 Case 运行选择规则；查询端口可来自数据库池或调用方已有事务。 */
export async function caseRunId(
  db: Pick<Database, 'query'>,
  id: string,
  runId?: string,
): Promise<string> {
  if (
    typeof id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(id) ||
    (runId !== undefined &&
      (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(runId)))
  )
    throw new ApiError(400, 'INVALID_RUN', '运行身份无效');
  const row = (
    await db.query<{ run_id: string }>(
      `SELECT run_id FROM pr_case_runs WHERE case_id=$1 AND deleted_at IS NULL AND ($2::text IS NULL OR run_id=$2) ORDER BY created_at DESC,run_id DESC LIMIT 1`,
      [id, runId ?? null],
    )
  ).rows[0];
  if (!row) throw new ApiError(404, 'CASE_MISSING', 'Case 不存在或运行已删除');
  return row.run_id;
}

/** 查询对象不是协议写入，不参与任务调度或修改任务定义。 */
export class TaskReader {
  constructor(private readonly db: Database) {}

  /** 兼容旧主任务身份；默认读取最新未删除运行，历史运行必须属于指定 case。 */
  async caseTask(id: string, runId?: string) {
    return this.task(await caseRunId(this.db, id, runId));
  }

  /** 历史只返回可见运行，报告和证据通过原任务详情读取。 */
  async caseRuns(id: string) {
    return (
      await this.db.query(
        `SELECT r.run_id AS "runId",r.run_id AS "taskId",t.state,r.created_at AS "createdAt",
      t.finished_at AS "finishedAt" FROM pr_case_runs r JOIN pr_tasks t ON t.id=r.run_id
      WHERE r.case_id=$1 AND r.deleted_at IS NULL ORDER BY r.created_at DESC,r.run_id DESC`,
        [id],
      )
    ).rows;
  }

  /** 优先投影同任务收尾；历史独立清理仍从关联表读取。 */
  async caseCleanup(id: string): Promise<CleanupFacts | null> {
    const parent = (
      await this.db.query<{
        definition: VerificationTask;
        state: string;
        report: VerificationReport | null;
        stepResults: StepResult[] | null;
      }>(
        'SELECT definition,state,report,step_results AS "stepResults" FROM pr_tasks WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (parent?.definition.cleanupStepIds !== undefined)
      return inlineCleanup(parent);
    return (
      (
        await this.db.query<CleanupFacts>(
          `SELECT c.task_id AS "taskId",coalesce(t.state,c.state) AS status,t.report
      FROM pr_case_cleanups c LEFT JOIN pr_tasks t ON t.id=c.task_id WHERE c.parent_task_id=$1`,
          [id],
        )
      ).rows[0] ?? null
    );
  }

  /** 返回任务与资源清理进度，避免把终态任务误认为浏览器已关闭。 */
  async task(id: string) {
    const task = (
      await this.db.query<{
        definition: VerificationTask;
        state:
          | 'QUEUED'
          | 'RUNNING'
          | 'COMPLETED'
          | 'CANCELLED'
          | 'TIMED_OUT'
          | 'ERROR';
        report: VerificationReport | null;
        stepResults?: StepResult[] | null;
        queueReason?: QueueReason | null;
        [key: string]: unknown;
      }>(
        'SELECT id,definition,state,deadline_at,report,error,created_at,finished_at,archived_at,step_results AS "stepResults",queue_reason AS "queueReason" FROM pr_tasks WHERE id=$1',
        [id],
      )
    ).rows[0];
    if (!task) throw new ApiError(404, 'TASK_MISSING', 'Task not found');
    const executions = (
      await this.db.query(
        `SELECT e.id,e.worker_id,e.state,e.lease_expires_at,s.id AS session_id,s.node_id,s.node_runtime,
      s.state AS session_state,s.closure_verified,s.close_reason,e.action_count,e.control_mode,e.control_revision,e.control_reason FROM pr_executions e JOIN pr_sessions s ON s.execution_id=e.id WHERE e.task_id=$1`,
        [id],
      )
    ).rows;
    const cleanup = task.definition.caseV2Definition
      ? await this.caseCleanup(id)
      : null;
    const outcome = (await taskOutcomes(this.db, [id])).get(id);
    return {
      ...task,
      ...(outcome ? { executionOutcome: outcome } : {}),
      ...(!['RUNNING', 'QUEUED'].includes(task.state) && task.report?.steps
        ? { stepResults: task.report.steps }
        : {}),
      ...summarizeReport(
        task.report,
        task.definition.acceptanceCriteria.map((c) => c.id),
        task.definition,
      ),
      executions,
      ...(task.definition.sessionPlan
        ? {
            identity: await identitySummary(
              this.db,
              id,
              task.definition.sessionPlan,
            ),
          }
        : {}),
      ...(task.definition.caseV2Definition
        ? {
            businessCleanup: cleanup
              ? { taskId: cleanup.taskId, status: cleanup.status }
              : null,
          }
        : {}),
    };
  }

  /** 列表只投影筛选和汇总所需事实，保持游标分页边界。 */
  async list(query: Record<string, unknown>): Promise<TaskList> {
    const invalid = () =>
      new ApiError(400, 'INVALID_QUERY', 'Invalid task list query or cursor');
    if (
      Object.keys(query).some(
        (key) =>
          ![
            'limit',
            'cursor',
            'state',
            'q',
            'reportOnly',
            'ungrouped',
            'taskKind',
          ].includes(key),
      )
    )
      throw invalid();
    if (Object.values(query).some((value) => typeof value !== 'string'))
      throw invalid();
    const limit =
      query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
    const state = query.state as string | undefined;
    const q = ((query.q as string | undefined) ?? '').trim();
    const reportOnly = query.reportOnly === 'true';
    const ungrouped = query.ungrouped === 'true';
    const taskKind = query.taskKind;
    if (taskKind !== undefined && taskKind !== 'browser') throw invalid();
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_LIMIT ||
      (state && !STATES.includes(state)) ||
      q.length > 160 ||
      (query.ungrouped !== undefined &&
        !['true', 'false'].includes(query.ungrouped as string)) ||
      (query.reportOnly !== undefined &&
        !['true', 'false'].includes(query.reportOnly as string))
    )
      throw invalid();
    const filter = JSON.stringify([
      state ?? '',
      q,
      reportOnly,
      ungrouped,
      ...(taskKind ? [taskKind] : []),
    ]);
    let cursor: Cursor | null = null;
    if (query.cursor !== undefined) {
      try {
        const encoded = query.cursor as string;
        if (encoded.length > 2048) throw invalid();
        const parsed: unknown = JSON.parse(
          Buffer.from(encoded, 'base64url').toString('utf8'),
        );
        if (!parsed || typeof parsed !== 'object') throw invalid();
        const value = parsed as Cursor;
        if (
          typeof value.at !== 'string' ||
          !CURSOR_TIME.test(value.at) ||
          !Number.isFinite(Date.parse(value.at)) ||
          new Date(value.at).toISOString().slice(0, 19) !==
            value.at.slice(0, 19) ||
          typeof value.id !== 'string' ||
          !ID_PATTERN.test(value.id) ||
          value.filter !== filter
        )
          throw invalid();
        cursor = value;
      } catch {
        throw invalid();
      }
    }
    const rows = (
      await this.db.query<
        Omit<
          TaskSummary,
          | 'created_at'
          | 'finished_at'
          | 'archived_at'
          | 'executionOutcome'
          | 'reportStatus'
          | 'criteriaCounts'
        > & {
          created_at: Date;
          finished_at: Date | null;
          cursor_at: string;
          archived_at: Date | null;
          report_facts: ReportFacts | null;
          criterion_ids: string[];
          report_scope: ReportScope;
        }
      >(
        `SELECT id,left(definition->>'objective',240) AS objective,definition#>>'{environment,nodePool}' AS node_pool,
        definition#>>'{target,url}' AS target_url,definition#>>'{caseV2Definition,caseId}' AS "caseId",definition->>'parentTaskId' AS "parentTaskId",
        definition->>'taskKind' AS "taskKind",definition->>'executionMode' AS "executionMode",state,created_at,finished_at,archived_at,
        CASE WHEN report IS NULL THEN NULL ELSE jsonb_build_object(
          'executionDisposition', report->'executionDisposition', 'verdict', report->'verdict',
          'steps', (SELECT coalesce(jsonb_agg(jsonb_build_object('stepId',s->'stepId','status',s->'status')),'[]'::jsonb) FROM jsonb_array_elements(report->'steps') s),
          'criteria', (SELECT coalesce(jsonb_agg(jsonb_build_object('criterionId',c->'criterionId','verdict',c->'verdict')),'[]'::jsonb) FROM jsonb_array_elements(report->'criteria') c)) END AS report_facts,
        ARRAY(SELECT c->>'id' FROM jsonb_array_elements(definition->'acceptanceCriteria') c) AS criterion_ids,
        jsonb_build_object(
          'taskKind', definition->'taskKind',
          'cleanupStepIds', coalesce(definition->'cleanupStepIds','[]'::jsonb),
          'steps', (SELECT coalesce(jsonb_agg(jsonb_build_object('stepId',s->'stepId')),'[]'::jsonb) FROM jsonb_array_elements(definition->'steps') s),
          'acceptanceCriteria', (SELECT coalesce(jsonb_agg(jsonb_build_object('id',c->'id','stepId',c->'stepId')),'[]'::jsonb) FROM jsonb_array_elements(definition->'acceptanceCriteria') c)
        ) AS report_scope,
        jsonb_array_length(report->'artifacts') AS "evidenceCount",
        report#>>'{executionDetails,reasonCode}' AS execution_reason_code,
        report->>'executionDisposition' AS execution_disposition,report->>'verdict' AS verdict,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
       FROM pr_tasks WHERE deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM pr_node_profiles p WHERE p.task_id=pr_tasks.id)
        AND (NOT $7::boolean OR NOT EXISTS(SELECT 1 FROM pr_request_runs a WHERE a.task_id=pr_tasks.id OR a.task_id=pr_tasks.definition->>'parentTaskId'))
        AND ($8::text IS NULL OR definition->>'taskKind'=$8)
        AND ($1::text IS NULL OR state=$1)
        AND ($2::text IS NULL OR id ILIKE $2 OR definition->>'objective' ILIKE $2)
        AND (NOT $3::boolean OR report IS NOT NULL)
        AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::text))
       ORDER BY created_at DESC,id DESC LIMIT $6`,
        [
          state || null,
          q ? `%${q.replace(LIKE_ESCAPE, '\\$&')}%` : null,
          reportOnly,
          cursor?.at ?? null,
          cursor?.id ?? null,
          limit + 1,
          ungrouped,
          taskKind ?? null,
        ],
      )
    ).rows;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const outcomes = await taskOutcomes(
      this.db,
      page.map((task) => task.id),
    );
    return {
      tasks: page.map(
        ({
          cursor_at: _,
          report_facts,
          criterion_ids,
          report_scope,
          ...task
        }) => ({
          ...task,
          executionOutcome: outcomes.get(task.id)!,
          ...summarizeReport(report_facts, criterion_ids, report_scope),
          archived_at: task.archived_at?.toISOString() ?? null,
          created_at: task.created_at.toISOString(),
          finished_at: task.finished_at?.toISOString() ?? null,
        }),
      ),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ at: last.cursor_at, id: last.id, filter }),
            ).toString('base64url')
          : null,
    };
  }
}
