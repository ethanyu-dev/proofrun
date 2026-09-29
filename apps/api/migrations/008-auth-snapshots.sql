-- 登录文件仍留在节点；控制面只记录自动槽位的节点归属和会话采用的恢复规则。
CREATE TABLE pr_auth_bindings (
  scope text PRIMARY KEY,
  node_id text NOT NULL REFERENCES pr_nodes(id)
);
ALTER TABLE pr_sessions ADD COLUMN auth_state jsonb;
