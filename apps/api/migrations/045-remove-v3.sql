-- 升级前必须用旧服务结束 external 运行并完成资源回收；不能把移除入口当成物理关闭。
-- 保留已完成任务、报告、证据及请求关联，不将未完成外部运行转交内置 Worker 重放。
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pr_tasks WHERE executor_kind='external' AND state IN ('QUEUED','RUNNING'))
    OR EXISTS (
      SELECT 1 FROM pr_executions e JOIN pr_tasks t ON t.id=e.task_id
      WHERE t.executor_kind='external' AND e.state IN ('STARTING','RUNNING')
    )
    OR EXISTS (
      SELECT 1 FROM pr_sessions s JOIN pr_executions e ON e.id=s.execution_id JOIN pr_tasks t ON t.id=e.task_id
      WHERE t.executor_kind='external' AND NOT s.closure_verified
    )
    OR EXISTS (
      SELECT 1 FROM pr_external_accounts a JOIN pr_tasks t ON t.id=a.task_id
      WHERE t.executor_kind='external' AND a.state NOT IN ('RELEASED','REVIEW')
    ) THEN
    RAISE EXCEPTION 'V3_EXECUTION_ACTIVE: 请先使用旧服务结束 external 任务、确认浏览器关闭并交还账号，再升级';
  END IF;
END $$;

-- v3 专用授权、幂等与控制账本不再有入口；公共运行时和 DevPass 账号表仍供 v1/v2 使用。
DROP TABLE pr_external_operations;
DROP TABLE pr_external_controllers;
DROP TABLE pr_public_calls;
DROP TABLE pr_public_owners;
ALTER TABLE pr_tasks DROP COLUMN binding_deadline_at;
ALTER TABLE pr_tasks DROP COLUMN executor_kind;
