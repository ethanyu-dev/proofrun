import type { PoolClient } from 'pg';
import type { Database } from '../../db.js';
import {
  summarizeReport,
  type ReportFacts,
  type ReportScope,
} from '@proofrun/contracts';
import type { CaseArmView, CaseEvent, CaseView } from './card.js';

/** 活动生命周期用于聚合整例完成，不能把单组完成提前上报为整例完成。 */
const ACTIVE = new Set(['QUEUED', 'RUNNING']);

/** 查询只投影通知用的字段，不读取账号、Cookie、模型输入或截图。 */
interface TaskFacts {
  /** 本组任务与上游 Case 身份。 */
  id: string;
  case_id: string;
  /** 卡片验证目标，不包含完整任务配置。 */
  objective: string;
  /** 历史比较任务仍需等待完整成员结束，但卡片不再展示执行模式。 */
  comparison: boolean;
  /** 持久生命周期及提交、结束事件时间。 */
  state: string;
  created_at: Date;
  finished_at: Date | null;
  /** 与 Console 共用的验收事实和步骤归属，排除证据正文。 */
  report_facts: ReportFacts | null;
  criterion_ids: string[];
  report_scope: ReportScope;
  /** 仅投影可展示原因，不读取错误堆栈。 */
  detail: string | null;
  /** 报告存在时才能生成报告入口。 */
  has_report: boolean;
  /** 执行身份、状态和租约用于判断处理入口是否仍有效。 */
  execution_id: string | null;
  execution_state: string | null;
  /** 当前控制代次和原因；原事件另从持久日志读取。 */
  control_mode: string | null;
  control_revision: number | null;
  control_reason: string | null;
  lease_expires_at: Date | null;
  /** 会话必须仍处于可操作状态。 */
  session_state: string | null;
  /** 当前代次未完成的请求，不含派生访问令牌。 */
  intervention_id: string | null;
  items: string[] | null;
  /** 链接、人工等待和清理截止取最早者。 */
  deadline: Date | null;
}

/** 从已有持久事件重建通知，不依赖轮询恰好观察到短暂的中间状态。 */
export async function readCase(
  db: Database,
  runKey: string,
): Promise<{ view: CaseView; events: CaseEvent[] }> {
  return db.transaction(async (client) => {
    // 同一快照同时读取状态和事件，不能把新事件和旧终态拼成矛盾卡片。
    await client.query(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    return readCaseSnapshot(client, runKey);
  });
}

/** 复用请求级一致性快照；指定成员时只读取请求冻结的执行身份。 */
export async function readCaseSnapshot(
  client: PoolClient,
  runKey: string,
  taskIds: string[] | null = null,
  since: Date | null = null,
): Promise<{ view: CaseView; events: CaseEvent[] }> {
  const rows = (
    await client.query<TaskFacts>(
      `SELECT t.id,COALESCE(t.definition#>>'{caseV2Definition,caseId}',t.definition#>>'{caseDefinition,caseId}',$1) AS case_id,
        t.definition->>'objective' AS objective,
        t.definition ? 'comparison' AS comparison,t.state,t.created_at,t.finished_at,
        CASE WHEN t.report IS NULL THEN NULL ELSE jsonb_build_object(
          'executionDisposition',t.report->'executionDisposition','verdict',t.report->'verdict',
          'steps',(SELECT coalesce(jsonb_agg(jsonb_build_object('stepId',s->'stepId','status',s->'status')),'[]'::jsonb) FROM jsonb_array_elements(t.report->'steps') s),
          'criteria',(SELECT coalesce(jsonb_agg(jsonb_build_object('criterionId',c->'criterionId','verdict',c->'verdict')),'[]'::jsonb) FROM jsonb_array_elements(t.report->'criteria') c)) END AS report_facts,
        ARRAY(SELECT c->>'id' FROM jsonb_array_elements(t.definition->'acceptanceCriteria') c) AS criterion_ids,
        jsonb_build_object(
          'cleanupStepIds',coalesce(t.definition->'cleanupStepIds','[]'::jsonb),
          'steps',(SELECT coalesce(jsonb_agg(jsonb_build_object('stepId',s->'stepId')),'[]'::jsonb) FROM jsonb_array_elements(t.definition->'steps') s),
          'acceptanceCriteria',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',c->'id','stepId',c->'stepId')),'[]'::jsonb) FROM jsonb_array_elements(t.definition->'acceptanceCriteria') c)) AS report_scope,
        COALESCE(t.report#>>'{humanDecision,reason}',t.error->>'code',t.report#>>'{executionDetails,reasonCode}') AS detail,
        t.report IS NOT NULL AS has_report,e.id AS execution_id,e.state AS execution_state,
        e.control_mode,e.control_revision,e.control_reason,e.lease_expires_at,s.state AS session_state,
        h.id AS intervention_id,h.items,LEAST(h.expires_at,e.human_deadline_at,t.cleanup_deadline_at) AS deadline
        FROM pr_tasks t LEFT JOIN pr_executions e ON e.task_id=t.id
        LEFT JOIN pr_sessions s ON s.execution_id=e.id
        LEFT JOIN pr_interventions h ON h.execution_id=e.id AND h.revision=e.control_revision AND h.completed_at IS NULL
        WHERE (($2::text[] IS NULL AND COALESCE(t.definition#>>'{comparison,id}',t.id)=$1) OR t.id=ANY($2::text[]))
        AND COALESCE(t.definition->>'purpose','verification')<>'cleanup'
        AND NOT EXISTS(SELECT 1 FROM pr_node_profiles p WHERE p.task_id=t.id)
        ORDER BY t.id`,
      [runKey, taskIds],
    )
  ).rows;
  if (!rows.length) throw new Error('通知对应的任务不存在');
  const ids = rows.map((row) => row.id);
  const controls = (
    await client.query<{
      id: string;
      task_id: string;
      execution_id: string;
      revision: number;
      reason: string;
      created_at: Date;
    }>(
      `SELECT c.id::text,c.execution_id,e.task_id,c.revision,c.reason,c.created_at
      FROM pr_control_events c JOIN pr_executions e ON e.id=c.execution_id
      WHERE e.task_id=ANY($1::text[])
        AND ($2::timestamptz IS NULL OR c.created_at >= $2 OR (c.revision=e.control_revision AND e.state='RUNNING' AND e.control_mode IN ('REQUESTED','HUMAN')))
        AND c.mode='REQUESTED'
      ORDER BY c.created_at,c.id`,
      [ids, since],
    )
  ).rows;
  const ended = (
    await client.query<{ key: string }>(
      `SELECT h.execution_id||':'||h.revision AS key FROM pr_interventions h JOIN pr_executions e ON e.id=h.execution_id
      WHERE e.task_id=ANY($1::text[]) AND (h.completed_at IS NOT NULL OR e.control_revision<>h.revision OR e.state<>'RUNNING')`,
      [ids],
    )
  ).rows.map((row) => row.key);
  const now = Date.now();
  const arms: CaseArmView[] = rows.map((row) => {
    const waiting =
      row.state === 'RUNNING' &&
      ['REQUESTED', 'HUMAN'].includes(row.control_mode ?? '');
    const valid =
      waiting &&
      row.intervention_id &&
      row.execution_state === 'RUNNING' &&
      row.session_state === 'ACTIVE' &&
      row.lease_expires_at &&
      row.lease_expires_at.getTime() > now &&
      row.deadline &&
      row.deadline.getTime() > now;
    return {
      taskId: row.id,
      label: rows.length === 1 ? '验证任务' : `任务 ${row.id}`,
      state: waiting ? 'WAITING_HUMAN' : row.state,
      verdict: summarizeReport(
        row.report_facts,
        row.criterion_ids,
        row.report_scope,
      ).reportStatus,
      detail: row.detail,
      hasReport: row.has_report,
      human: valid
        ? {
            id: row.intervention_id!,
            executionId: row.execution_id!,
            revision: row.control_revision!,
            reason: row.control_reason ?? '需要人工处理',
            items: row.items ?? [],
            deadline: row.deadline!.toISOString(),
          }
        : null,
    };
  });
  const terminal =
    rows.length >=
      (taskIds?.length ?? (rows.some((row) => row.comparison) ? 2 : 1)) &&
    rows.every((row) => !ACTIVE.has(row.state));
  const state = terminal
    ? rows.every((row) => row.state === 'COMPLETED')
      ? 'COMPLETED'
      : 'ENDED'
    : arms.some((arm) => arm.state === 'WAITING_HUMAN')
      ? 'WAITING_HUMAN'
      : rows.every((row) => row.state === 'QUEUED')
        ? 'QUEUED'
        : 'RUNNING';
  const events: CaseEvent[] = [
    {
      key: 'submitted',
      kind: 'SUBMITTED',
      at: new Date(
        Math.min(...rows.map((row) => row.created_at.getTime())),
      ).toISOString(),
      taskId: null,
      executionId: null,
      revision: null,
      reason: null,
    },
    // 每个 case 只创建一张人工处理卡片；后续代次和恢复均同步原消息。
    ...controls.slice(0, 1).map((row) => ({
      key: 'hitl',
      kind: 'HITL' as const,
      at: row.created_at.toISOString(),
      taskId: row.task_id,
      executionId: row.execution_id,
      revision: row.revision,
      reason: row.reason,
    })),
  ];
  if (terminal)
    events.push({
      key: 'completed',
      kind: 'COMPLETED',
      at: new Date(
        Math.max(
          ...rows.map((row) => (row.finished_at ?? row.created_at).getTime()),
        ),
      ).toISOString(),
      taskId: null,
      executionId: null,
      revision: null,
      reason: null,
    });
  return {
    view: {
      caseId: rows[0]!.case_id,
      objective: rows[0]!.objective,
      state,
      terminal,
      arms,
      endedRequests: ended.sort(),
    },
    events,
  };
}
