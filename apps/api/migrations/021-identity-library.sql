-- 用户只维护账号信息；Cookie 文件版本与页面修改版本分开，已提交任务保留原种子。
CREATE TABLE pr_identity_library (
  id text PRIMARY KEY,
  revision integer NOT NULL DEFAULT 1,
  version text NOT NULL,
  url text NOT NULL,
  name text NOT NULL,
  identity_type text NOT NULL DEFAULT '',
  description text NOT NULL,
  concurrency integer NOT NULL CHECK (concurrency BETWEEN 1 AND 32),
  cookie_file uuid,
  baseline_node text REFERENCES pr_nodes(id),
  deleted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- 版本引用用于领取后投递；编辑或删除目录不能使已冻结任务丢失种子。
CREATE TABLE pr_identity_seeds (version text PRIMARY KEY, cookie_file uuid);
-- 同一对照轮次共享一次模型选择；短租约避免多个 worker 重复请求模型。
CREATE TABLE pr_identity_selections (
  scope text PRIMARY KEY,
  claim_token uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  plan jsonb,
  selected_at timestamptz
);
-- 人工终止原因独立于任务错误和验收结论，断线后仍可核查。
ALTER TABLE pr_interventions ADD COLUMN unable_reason text;
