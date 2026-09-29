-- 一次人工请求绑定一个操作代次；仅保存链接凭据摘要，完成后永久失效。
CREATE TABLE pr_interventions (
  id text PRIMARY KEY,
  execution_id text NOT NULL REFERENCES pr_executions(id),
  revision integer NOT NULL,
  token_hash text NOT NULL,
  items jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE(execution_id, revision)
);
