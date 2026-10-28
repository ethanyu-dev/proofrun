-- 默认模板只持久化公开元数据；登录文件始终留在所属节点。
ALTER TABLE pr_nodes ADD COLUMN default_profile jsonb;
-- 旧维护记录不自动恢复；新记录显式标识生命周期与发布状态。
ALTER TABLE pr_node_profiles ADD COLUMN managed boolean NOT NULL DEFAULT false;
ALTER TABLE pr_node_profiles ADD COLUMN publish_state text NOT NULL DEFAULT 'IDLE'
  CHECK (publish_state IN ('IDLE','SAVING','SAVED','FAILED','DISCARDED'));
ALTER TABLE pr_node_profiles ADD COLUMN published_profile jsonb;
ALTER TABLE pr_node_profiles ADD COLUMN failure_code text;
