/**
 * 先按不可变执行身份去重，再截取首次提交时间；不能连接请求成员，否则复用会重复计数。
 * 历史双跑沿用 Console 的 JEV 优先规则，两个执行组仍在用量查询中分别计费。
 * 只读取判定需要的字段，避免把模型正文与证据载入看板。
 */
export const DASHBOARD_CASES_SQL = `
WITH candidates AS (
  SELECT DISTINCT coalesce('comparison:' || (definition#>>'{comparison,id}'), 'task:' || id) AS identity
  FROM pr_tasks WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
), logical_cases AS (
  SELECT min(created_at) AS created_at,
    (array_agg(id ORDER BY (definition#>>'{comparison,arm}'='jev') DESC NULLS LAST,created_at,id))[1] AS task_id
  FROM pr_tasks JOIN candidates c ON c.identity=coalesce('comparison:' || (definition#>>'{comparison,id}'), 'task:' || id)
  WHERE coalesce(definition->>'purpose','') <> 'cleanup'
    AND NOT EXISTS (SELECT 1 FROM pr_case_cleanups c WHERE c.task_id=pr_tasks.id)
  GROUP BY coalesce('comparison:' || (definition#>>'{comparison,id}'), 'task:' || id)
)
SELECT to_char(c.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS date,
  t.state,
  jsonb_build_object('acceptanceCriteria',(SELECT jsonb_agg(jsonb_build_object('id',a->'id','stepId',a->'stepId')) FROM jsonb_array_elements(t.definition->'acceptanceCriteria') a),
    'cleanupStepIds',t.definition->'cleanupStepIds',
    'steps',(SELECT jsonb_agg(jsonb_build_object('stepId',s->'stepId')) FROM jsonb_array_elements(t.definition->'steps') s)) AS scope,
  CASE WHEN t.report IS NULL THEN NULL ELSE jsonb_build_object(
    'executionDisposition',t.report->'executionDisposition','verdict',t.report->'verdict',
    'criteria',(SELECT coalesce(jsonb_agg(jsonb_build_object('criterionId',r->'criterionId','verdict',r->'verdict')),'[]'::jsonb) FROM jsonb_array_elements(t.report->'criteria') r),
    'steps',(SELECT jsonb_agg(jsonb_build_object('stepId',s->'stepId','status',s->'status')) FROM jsonb_array_elements(t.report->'steps') s)
  ) END AS report
FROM logical_cases c JOIN pr_tasks t ON t.id=c.task_id
WHERE c.created_at >= $1::timestamptz AND c.created_at < $2::timestamptz`;

/**
 * 用量使用服务端调用开始时间，重试、跨日、清理及多次分析各自归日。
 * 旧报告只有汇总时按结束日回填，并单独返回回填数量；已有调用记录则绝不再叠加报告汇总。
 * 在 SQL 内完成聚合，响应体大小只与日期数有关，与调用正文大小无关。
 */
export const DASHBOARD_USAGE_SQL = `
WITH usage AS (
  SELECT created_at AS at, 'execution' AS kind,
    (record->>'promptTokens')::bigint AS prompt,
    (record->>'completionTokens')::bigint AS completion,
    1::bigint AS calls, 0 AS legacy
  FROM pr_model_calls WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
  UNION ALL
  SELECT started_at, 'analysis', prompt_tokens, completion_tokens, 1, 0
  FROM pr_analysis_calls WHERE started_at >= $1::timestamptz AND started_at < $2::timestamptz
  UNION ALL
  SELECT t.finished_at, 'execution',
    (t.report#>>'{executionDetails,promptTokens}')::bigint,
    (t.report#>>'{executionDetails,completionTokens}')::bigint,
    coalesce((t.report#>>'{executionDetails,modelCalls}')::bigint,0), 1
  FROM pr_tasks t
  WHERE t.finished_at >= $1::timestamptz AND t.finished_at < $2::timestamptz
    AND t.report ? 'executionDetails'
    AND jsonb_typeof(t.report->'executionDetails')='object'
    AND NOT EXISTS (SELECT 1 FROM pr_executions e JOIN pr_model_calls m ON m.execution_id=e.id WHERE e.task_id=t.id)
)
SELECT to_char(at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS date,kind,
  sum(prompt) AS prompt, sum(completion) AS completion, sum(calls) AS calls,
  sum(CASE WHEN prompt IS NULL OR completion IS NULL THEN calls ELSE 0 END) AS unmeasured,
  sum(legacy) AS legacy
FROM usage GROUP BY date,kind`;
