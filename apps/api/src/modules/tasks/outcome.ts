import { executionOutcome, type ExecutionFacts } from '@proofrun/contracts';
import type { Database } from '../../db.js';

/** 批量读取原因投影；历史人工请求按当前代次关联，已恢复的阻塞不会污染后续故障。 */
export async function taskOutcomes(db: Pick<Database, 'query'>, ids: string[]) {
  if (!ids.length)
    return new Map<string, ReturnType<typeof executionOutcome>>();
  const rows = await db.query<ExecutionFacts & { id: string }>(
    `
    SELECT t.id,t.state,t.error->>'code' AS code,
      CASE WHEN t.report ? 'humanDecision' THEN 'HUMAN_UNEXECUTABLE' ELSE t.report#>>'{executionDetails,reasonCode}' END AS "reportCode",
      t.report#>>'{humanDecision,reason}' AS "humanReason",
      t.report->>'executionDisposition' AS disposition,
      e.control_mode AS "controlMode",e.control_reason AS "blockingReason",
      h.reason_code AS "blockingCode",
      to_char(e.human_requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "waitingSince",
      to_char(e.human_deadline_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "waitDeadline"
    FROM pr_tasks t
    LEFT JOIN LATERAL (SELECT * FROM pr_executions WHERE task_id=t.id ORDER BY created_at DESC,id DESC LIMIT 1) e ON true
    LEFT JOIN pr_interventions h ON h.execution_id=e.id AND h.revision=e.control_revision AND h.completed_at IS NULL
    WHERE t.id=ANY($1::text[])`,
    [ids],
  );
  return new Map(rows.rows.map((row) => [row.id, executionOutcome(row)]));
}
