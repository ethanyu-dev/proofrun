-- 独立业务清理不能被升级静默跳过。请在旧版本完成或明确跳过遗留意图，
-- 并等待原浏览器确认关闭后再升级；迁移失败不会改写历史记录。
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pr_case_cleanups c LEFT JOIN pr_tasks t ON t.id=c.task_id
    WHERE c.state <> 'SKIPPED' AND (t.id IS NULL OR t.state IN ('QUEUED','RUNNING'))
  ) OR EXISTS (
    SELECT 1 FROM pr_tasks t LEFT JOIN pr_executions e ON e.task_id=t.id
    LEFT JOIN pr_sessions s ON s.execution_id=e.id
    WHERE t.definition->>'purpose'='cleanup'
      AND (t.state IN ('QUEUED','RUNNING') OR s.closure_verified=false)
  ) THEN
    RAISE EXCEPTION 'LEGACY_CLEANUP_PENDING: 请使用旧版本完成遗留独立清理并确认浏览器关闭，再升级';
  END IF;
  -- 原始任务曾允许调用者显式声明互斥，升级前必须排空，不能静默改变冻结语义。
  IF EXISTS (
    SELECT 1 FROM pr_tasks WHERE state IN ('QUEUED','RUNNING')
      AND definition ? 'resourceKey' AND NOT definition ? 'caseV2Definition'
  ) THEN
    RAISE EXCEPTION 'LEGACY_RESOURCE_LOCK_PENDING: 请使用旧版本完成带资源锁的原始任务，再升级';
  END IF;
END $$;

-- 新请求只由 cases 保存一次运行归属；旧双跑从组在读取边界补入。
-- 保留原 arms 表，历史记录与冻结请求不会被迁移重写。
CREATE VIEW pr_request_runs AS
  SELECT c.request_id,c.case_id,c.task_id,
    coalesce(t.definition#>>'{comparison,arm}',t.definition->>'executionMode','llm') AS execution_mode
  FROM pr_verification_request_cases c JOIN pr_tasks t ON t.id=c.task_id
  UNION ALL
  SELECT a.request_id,a.case_id,a.task_id,a.execution_mode
  FROM pr_verification_request_arms a
  JOIN pr_verification_request_cases c USING(request_id,case_id)
  WHERE a.task_id <> c.task_id;

-- 主运行不再写 arms，状态变化仍须使所有关联请求的派生摘要失效。
CREATE OR REPLACE FUNCTION pr_invalidate_task_requests() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pr_request_summary_dirty(request_id)
    SELECT DISTINCT request_id FROM pr_request_runs WHERE task_id=NEW.id ORDER BY request_id
  ON CONFLICT(request_id) DO UPDATE SET revision=pr_request_summary_dirty.revision+1;
  RETURN NULL;
END $$;
INSERT INTO pr_request_summary_dirty(request_id)
  SELECT request_id FROM pr_verification_requests
  ON CONFLICT(request_id) DO UPDATE SET revision=pr_request_summary_dirty.revision+1;
