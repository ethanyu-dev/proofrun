-- 公共接入只增加归属与幂等回执，不复制任务、账号或报告；软删除后保留归属防止旧键复活。
CREATE TABLE pr_public_owners (
  kind text NOT NULL CHECK (kind IN ('run','request')),
  resource_id text NOT NULL,
  principal_id text NOT NULL,
  PRIMARY KEY(kind,resource_id)
);
CREATE INDEX pr_public_owner_principal ON pr_public_owners(principal_id,kind);

-- 与现有入队/取消/请求成员替换同事务写入；只保存已成功提交的操作。
CREATE TABLE pr_public_calls (
  principal_id text NOT NULL,
  namespace text NOT NULL CHECK (namespace IN ('browser-submit','verification-submit','operation')),
  call_key text NOT NULL,
  input_hash text NOT NULL,
  result jsonb NOT NULL,
  resources jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(principal_id,namespace,call_key)
);
