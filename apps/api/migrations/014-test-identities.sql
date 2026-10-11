-- 身份分配与领取事务提交；只有会话物理关闭后才释放底层账号容量。
CREATE TABLE pr_identity_assignments (
  task_id text PRIMARY KEY REFERENCES pr_tasks(id),
  account_key text NOT NULL,
  identity jsonb NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX pr_identity_account ON pr_identity_assignments(account_key);
