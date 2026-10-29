-- 退役模式按冻结定义识别，不按 taskId 前缀猜测；sourceTaskId 只是溯源，不能删除独立源任务。
CREATE TEMP TABLE retired_tasks ON COMMIT DROP AS
WITH RECURSIVE edges(child,parent) AS (
  SELECT id,definition->>'parentTaskId' FROM pr_tasks
  UNION SELECT task_id,parent_task_id FROM pr_case_cleanups
), retired(id) AS (
  SELECT id FROM pr_tasks
  WHERE definition ? 'comparison' OR definition->>'executionMode' IN ('jev','parallel')
  UNION
  SELECT e.child FROM edges e JOIN retired r ON e.parent=r.id
) SELECT id FROM retired;
CREATE UNIQUE INDEX ON retired_tasks(id);
CREATE TEMP TABLE retired_executions ON COMMIT DROP AS
  SELECT id FROM pr_executions WHERE task_id IN (SELECT id FROM retired_tasks);
CREATE TEMP TABLE retired_sessions ON COMMIT DROP AS
  SELECT id FROM pr_sessions WHERE execution_id IN (SELECT id FROM retired_executions);
CREATE TEMP TABLE affected_requests ON COMMIT DROP AS
  SELECT DISTINCT request_id FROM pr_request_runs WHERE task_id IN (SELECT id FROM retired_tasks);
CREATE TEMP TABLE retired_run_keys ON COMMIT DROP AS
  SELECT id AS key FROM retired_tasks
  UNION SELECT definition#>>'{comparison,id}' FROM pr_tasks WHERE id IN (SELECT id FROM retired_tasks);

-- 删除审计记录不能代替实际资源关闭；有在途资源时回滚整个升级，保留原服务的收尾依据。
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pr_tasks WHERE id IN (SELECT id FROM retired_tasks) AND state IN ('QUEUED','RUNNING'))
    OR EXISTS (SELECT 1 FROM pr_sessions WHERE id IN (SELECT id FROM retired_sessions) AND NOT closure_verified)
    OR EXISTS (SELECT 1 FROM pr_external_accounts WHERE task_id IN (SELECT id FROM retired_tasks) AND state NOT IN ('RELEASED','REVIEW')) THEN
    RAISE EXCEPTION 'RETIRED_EXECUTION_ACTIVE: 请先结束退役任务、关闭浏览器并交还账号，再移除历史记录';
  END IF;
END $$;

-- 视图仅保留当前单执行关联；移除从组表，不能让遗留关联继续参与报告与计量。
CREATE OR REPLACE VIEW pr_request_runs AS
  SELECT c.request_id,c.case_id,c.task_id,'llm'::text AS execution_mode
  FROM pr_verification_request_cases c JOIN pr_tasks t ON t.id=c.task_id;
DROP TABLE pr_verification_request_arms;
DELETE FROM pr_verification_request_cases WHERE task_id IN (SELECT id FROM retired_tasks);
CREATE TEMP TABLE retired_requests ON COMMIT DROP AS
  SELECT request_id FROM affected_requests a
  WHERE NOT EXISTS (SELECT 1 FROM pr_verification_request_cases c WHERE c.request_id=a.request_id);
INSERT INTO retired_run_keys SELECT 'request:'||request_id FROM affected_requests;
-- 重跑通知带摘要后缀，旧轮次同样不能留下退役成员的消息正文。
INSERT INTO retired_run_keys SELECT n.run_key FROM pr_feishu_runs n WHERE EXISTS (
  SELECT 1 FROM affected_requests a WHERE n.run_key='request:'||a.request_id
    OR starts_with(n.run_key,'request:'||a.request_id||':')
);
CREATE TEMP TABLE retained_notification_keys ON COMMIT DROP AS
  SELECT DISTINCT n.run_key FROM pr_feishu_runs n WHERE EXISTS (
    SELECT 1 FROM affected_requests a WHERE a.request_id NOT IN (SELECT request_id FROM retired_requests)
      AND (n.run_key='request:'||a.request_id OR starts_with(n.run_key,'request:'||a.request_id||':'))
  );
DELETE FROM pr_feishu_messages WHERE run_key IN (SELECT key FROM retired_run_keys);
-- 混合请求保留已结算的轮询游标，避免升级重新发送旧提交通知。
UPDATE pr_feishu_runs SET settled_at=coalesce(settled_at,clock_timestamp())
WHERE run_key IN (SELECT run_key FROM retained_notification_keys);
DELETE FROM pr_feishu_runs WHERE run_key IN (SELECT key FROM retired_run_keys)
  AND run_key NOT IN (SELECT run_key FROM retained_notification_keys);

-- 删除会重新返回旧任务身份的幂等回执；混合请求的正常成员和原始执行仍保留。
DELETE FROM pr_public_calls p WHERE EXISTS (
  SELECT 1 FROM jsonb_path_query(p.resources,'$.** ? (@.type() == "string")') v
  WHERE v #>> '{}' IN (SELECT id FROM retired_tasks UNION SELECT request_id FROM affected_requests)
);
DELETE FROM pr_public_owners WHERE
  (kind='run' AND resource_id IN (SELECT id FROM retired_tasks))
  OR (kind='request' AND resource_id IN (SELECT request_id FROM retired_requests));
DELETE FROM pr_request_reruns WHERE request_id IN (SELECT request_id FROM affected_requests);
UPDATE pr_verification_requests SET source_request_id=NULL WHERE source_request_id IN (SELECT request_id FROM retired_requests);
DELETE FROM pr_verification_requests WHERE request_id IN (SELECT request_id FROM retired_requests);

-- 按外键从叶子向父记录删除，保留节点与正常任务的资源归属。
DELETE FROM pr_external_operations WHERE run_id IN (SELECT id FROM retired_tasks);
DELETE FROM pr_external_controllers WHERE run_id IN (SELECT id FROM retired_tasks);
DELETE FROM pr_runtime_operations WHERE execution_id IN (SELECT id FROM retired_executions);
DELETE FROM pr_runtime_decisions WHERE execution_id IN (SELECT id FROM retired_executions);
DELETE FROM pr_execution_runtimes WHERE execution_id IN (SELECT id FROM retired_executions);
DELETE FROM pr_node_profiles WHERE task_id IN (SELECT id FROM retired_tasks);
DELETE FROM pr_external_accounts WHERE task_id IN (SELECT id FROM retired_tasks);
DELETE FROM pr_identity_assignments WHERE task_id IN (SELECT id FROM retired_tasks);
DELETE FROM pr_admission_rejections WHERE task_id IN (SELECT id FROM retired_tasks);
DELETE FROM pr_node_inbox WHERE payload->>'artifactId' IN (SELECT id FROM pr_artifacts WHERE execution_id IN (SELECT id FROM retired_executions))
  OR payload->>'sessionId' IN (SELECT id FROM retired_sessions)
  OR payload->>'commandId' IN (SELECT id FROM pr_commands WHERE execution_id IN (SELECT id FROM retired_executions));
DELETE FROM pr_artifacts WHERE execution_id IN (SELECT id FROM retired_executions);
DELETE FROM pr_commands WHERE execution_id IN (SELECT id FROM retired_executions);
DELETE FROM pr_human_commands WHERE execution_id IN (SELECT id FROM retired_executions);
DELETE FROM pr_control_events WHERE execution_id IN (SELECT id FROM retired_executions);
DELETE FROM pr_model_calls WHERE execution_id IN (SELECT id FROM retired_executions);
DELETE FROM pr_interventions WHERE execution_id IN (SELECT id FROM retired_executions);
DELETE FROM pr_sessions WHERE id IN (SELECT id FROM retired_sessions);
DELETE FROM pr_executions WHERE id IN (SELECT id FROM retired_executions);
DELETE FROM pr_case_cleanups WHERE parent_task_id IN (SELECT id FROM retired_tasks) OR task_id IN (SELECT id FROM retired_tasks);
DELETE FROM pr_identity_selections WHERE scope IN (SELECT key FROM retired_run_keys);
DELETE FROM pr_tasks WHERE id IN (SELECT id FROM retired_tasks);

-- 清除退役模式索引和查询分支，并在存储边界拒绝再次写入旧模式。
DROP INDEX pr_tasks_notification_run;
DROP INDEX pr_tasks_statistics_identity;
DROP INDEX pr_case_run_history;
DROP INDEX pr_task_logical_case;
DROP INDEX pr_task_visible_run;
CREATE INDEX pr_case_run_history ON pr_tasks((definition#>>'{caseV2Definition,caseId}'),created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX pr_task_logical_case ON pr_tasks((coalesce('case:' || (definition#>>'{caseV2Definition,caseId}'),'task:' || id)));
CREATE OR REPLACE VIEW pr_case_runs AS
  SELECT definition#>>'{caseV2Definition,caseId}' AS case_id,id AS run_id,created_at,deleted_at
  FROM pr_tasks WHERE definition ? 'caseV2Definition' AND coalesce(definition->>'purpose','') <> 'cleanup';
ALTER TABLE pr_tasks ADD CONSTRAINT pr_tasks_llm_only CHECK (
  NOT definition ? 'comparison' AND coalesce(definition->>'executionMode','llm')='llm'
);
-- 所有派生摘要升级到单执行契约；回填仍由启动器在准入前完成。
INSERT INTO pr_request_summary_dirty(request_id) SELECT request_id FROM pr_verification_requests
ON CONFLICT(request_id) DO UPDATE SET revision=pr_request_summary_dirty.revision+1;
