/** 与验证任务页共用请求运行视图及删除边界；独立任务和未关联重跑不进入看板。 */
const REQUEST_MEMBERS_SQL = `
members AS (
  SELECT r.request_id,r.created_at AS request_created_at,a.case_id,a.task_id,a.execution_mode
  FROM pr_verification_requests r JOIN pr_request_runs a USING(request_id)
  JOIN pr_tasks t ON t.id=a.task_id
  WHERE r.deleted_at IS NULL AND t.deleted_at IS NULL
)`;

/**
 * 一条请求成员对应任务页的一条 Case 展示行，复用成员在各自请求内分别计数。
 * 按请求创建日归属，只从该请求当前关联中选择展示组。
 * 只读取判定所需字段，不向应用层加载报告正文和证据。
 * 缺最终报告时按步骤定义取首条保存记录，与 Case 详情投影一致，保留异常结束前已证实的失败。
 */
export const DASHBOARD_CASES_SQL = `
WITH ${REQUEST_MEMBERS_SQL}, displayed_cases AS (
  SELECT DISTINCT ON (request_id,case_id) request_created_at,task_id
  FROM members WHERE request_created_at >= $1::timestamptz AND request_created_at < $2::timestamptz
  ORDER BY request_id,case_id,task_id
)
SELECT to_char(c.request_created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS date,
  t.state,
  CASE WHEN t.report IS NOT NULL THEN '[]'::jsonb ELSE (
    SELECT coalesce(jsonb_agg(jsonb_build_object('criterionId',c->'criterionId','verdict',c->'verdict')),'[]'::jsonb)
    FROM jsonb_array_elements(t.definition->'steps') d
    CROSS JOIN LATERAL (SELECT s FROM jsonb_array_elements(t.step_results) s WHERE s->>'stepId'=d->>'stepId' LIMIT 1) saved
    CROSS JOIN LATERAL jsonb_array_elements(saved.s->'criteria') c
  ) END AS step_criteria,
  jsonb_build_object('acceptanceCriteria',(SELECT jsonb_agg(jsonb_build_object('id',a->'id','stepId',a->'stepId')) FROM jsonb_array_elements(t.definition->'acceptanceCriteria') a),
    'cleanupStepIds',t.definition->'cleanupStepIds',
    'steps',(SELECT jsonb_agg(jsonb_build_object('stepId',s->'stepId')) FROM jsonb_array_elements(t.definition->'steps') s)) AS scope,
  CASE WHEN t.report IS NULL THEN NULL ELSE jsonb_build_object(
    'executionDisposition',t.report->'executionDisposition','verdict',t.report->'verdict',
    'criteria',(SELECT coalesce(jsonb_agg(jsonb_build_object('criterionId',r->'criterionId','verdict',r->'verdict')),'[]'::jsonb) FROM jsonb_array_elements(t.report->'criteria') r),
    'steps',(SELECT jsonb_agg(jsonb_build_object('stepId',s->'stepId','status',s->'status')) FROM jsonb_array_elements(t.report->'steps') s)
  ) END AS report
FROM displayed_cases c JOIN pr_tasks t ON t.id=c.task_id`;

/**
 * 只统计可见请求当前关联的全部执行组及其清理，按任务身份去重，复用不重复计费。
 * 用量使用服务端调用开始时间，重试、跨日及清理各自归日；被替换的历史运行不计入。
 * 旧报告只有汇总时按结束日回填，并单独返回回填数量；已有调用记录则绝不再叠加报告汇总。
 * 在 SQL 内完成聚合，响应体大小只与日期数有关，与调用正文大小无关。
 */
export const DASHBOARD_USAGE_SQL = `
WITH ${REQUEST_MEMBERS_SQL}, ids AS (
  SELECT task_id FROM members
  UNION
  SELECT c.task_id FROM pr_case_cleanups c JOIN members m ON m.task_id=c.parent_task_id WHERE c.task_id IS NOT NULL
), usage AS (
  SELECT m.created_at AS at, 'execution' AS kind,
    (record->>'promptTokens')::bigint AS prompt,
    (record->>'completionTokens')::bigint AS completion,
    1::bigint AS calls, 0 AS legacy
  FROM pr_model_calls m JOIN pr_executions e ON e.id=m.execution_id JOIN ids ON ids.task_id=e.task_id JOIN pr_tasks t ON t.id=e.task_id WHERE t.deleted_at IS NULL AND m.created_at >= $1::timestamptz AND m.created_at < $2::timestamptz
  UNION ALL
  SELECT t.finished_at, 'execution',
    (t.report#>>'{executionDetails,promptTokens}')::bigint,
    (t.report#>>'{executionDetails,completionTokens}')::bigint,
    coalesce((t.report#>>'{executionDetails,modelCalls}')::bigint,0), 1
  FROM ids JOIN pr_tasks t ON t.id=ids.task_id
  WHERE t.deleted_at IS NULL AND t.finished_at >= $1::timestamptz AND t.finished_at < $2::timestamptz
    AND t.report ? 'executionDetails'
    AND jsonb_typeof(t.report->'executionDetails')='object'
    AND NOT EXISTS (SELECT 1 FROM pr_executions e JOIN pr_model_calls m ON m.execution_id=e.id WHERE e.task_id=t.id)
)
SELECT to_char(at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS date,kind,
  sum(prompt) AS prompt, sum(completion) AS completion, sum(calls) AS calls,
  sum(CASE WHEN prompt IS NULL OR completion IS NULL THEN calls ELSE 0 END) AS unmeasured,
  sum(legacy) AS legacy
FROM usage GROUP BY date,kind`;

/** 当前关联运行按运行创建日计数，复用按任务身份去重；不包含被替换的历史运行。 */
export const DASHBOARD_RUNS_SQL = `
WITH ${REQUEST_MEMBERS_SQL}, ids AS (
  SELECT DISTINCT task_id FROM members
)
SELECT to_char(min(t.created_at) AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS date
FROM ids JOIN pr_tasks t ON t.id=ids.task_id
GROUP BY t.id
HAVING min(t.created_at) >= $1::timestamptz AND min(t.created_at) < $2::timestamptz`;
