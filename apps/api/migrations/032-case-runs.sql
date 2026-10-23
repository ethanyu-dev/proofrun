-- 删除与证据归档独立：原记录保留，业务读取和计量统一排除删除项。
ALTER TABLE pr_tasks ADD COLUMN deleted_at timestamptz;
ALTER TABLE pr_verification_requests ADD COLUMN deleted_at timestamptz;
ALTER TABLE pr_request_analyses ADD COLUMN excluded_at timestamptz;
ALTER TABLE pr_analysis_calls ADD COLUMN excluded_at timestamptz;
CREATE INDEX pr_case_run_history ON pr_tasks((definition#>>'{caseV2Definition,caseId}'),created_at DESC,id DESC)
  WHERE deleted_at IS NULL AND coalesce(definition#>>'{comparison,arm}','') <> 'jev';

-- 原 taskId 即首轮运行身份，无需改写历史定义、证据或请求的冻结关联。
CREATE VIEW pr_case_runs AS
  SELECT definition#>>'{caseV2Definition,caseId}' AS case_id,id AS run_id,created_at,deleted_at
  FROM pr_tasks WHERE definition ? 'caseV2Definition'
    AND coalesce(definition#>>'{comparison,arm}','') <> 'jev'
    AND coalesce(definition->>'purpose','') <> 'cleanup';
CREATE TRIGGER pr_task_request_deleted AFTER UPDATE OF deleted_at ON pr_tasks
  FOR EACH ROW WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
  EXECUTE FUNCTION pr_invalidate_task_requests();

-- 日期候选只扩展同一 case 或运行，不必对历史定义做全表展开。
CREATE INDEX pr_task_logical_case ON pr_tasks((coalesce('case:' || (definition#>>'{caseV2Definition,caseId}'),'comparison:' || (definition#>>'{comparison,id}'),'task:' || id)));
CREATE INDEX pr_task_visible_run ON pr_tasks((coalesce(definition#>>'{comparison,id}',id))) WHERE deleted_at IS NULL;
