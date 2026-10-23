-- 外部租约和申请意图独立于任务终态；只有确认资源停止后才交还。
CREATE TABLE pr_external_accounts (
  task_id text PRIMARY KEY REFERENCES pr_tasks(id),
  request_id text NOT NULL UNIQUE,
  request jsonb NOT NULL,
  provider_id text NOT NULL,
  client_id text NOT NULL,
  node_id text NOT NULL,
  reserved_until timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'REQUESTED' CHECK (state IN ('REQUESTED','ALLOCATED','IN_USE','RELEASE_PENDING','RELEASED','REVIEW')),
  journal jsonb NOT NULL DEFAULT '{}',
  account_id text,
  material_version text,
  lease_id text,
  expires_at timestamptz,
  account_summary jsonb,
  session_id text REFERENCES pr_sessions(id),
  release_outcome text,
  reason text,
  retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX pr_external_accounts_pending ON pr_external_accounts(retry_at) WHERE state NOT IN ('RELEASED','REVIEW');

-- 会话保存已经扣除关闭余量的硬期限，所有执行授权共享此上限。
ALTER TABLE pr_sessions ADD COLUMN external_expires_at timestamptz;
