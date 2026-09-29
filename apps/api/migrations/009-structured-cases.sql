-- 逐步结果与清理意图独立持久化，worker 退出不应丢失已完成事实。
ALTER TABLE pr_tasks ADD COLUMN step_results jsonb;
CREATE TABLE pr_case_cleanups (
  parent_task_id text PRIMARY KEY REFERENCES pr_tasks(id),
  task_id text NOT NULL UNIQUE,
  definition jsonb NOT NULL,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','QUEUED','SKIPPED'))
);
CREATE INDEX pr_task_resource ON pr_tasks((definition->>'resourceKey')) WHERE definition ? 'resourceKey';
