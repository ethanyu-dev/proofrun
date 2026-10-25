-- 节点地址来自受认证心跳；旧 capacity 仅保留供历史读取，不再参与准入。
ALTER TABLE pr_nodes ADD COLUMN public_url text;
ALTER TABLE pr_nodes ADD COLUMN admission jsonb;
ALTER TABLE pr_nodes ADD COLUMN admission_retry_at timestamptz;
ALTER TABLE pr_tasks ADD COLUMN queue_deadline_at timestamptz;
-- 尚未创建浏览器的调度拒绝单独归档；执行者旧令牌随拒绝尝试移除，不能复活。
CREATE TABLE pr_admission_rejections (
  execution_id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES pr_tasks(id),
  node_id text NOT NULL REFERENCES pr_nodes(id),
  session_id text NOT NULL,
  commands jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- 人工输入不送往控制面；节点账本保存去重哈希和回执；控制面保存不含输入值的操作回执。
CREATE TABLE pr_human_commands (
  id text PRIMARY KEY,
  execution_id text NOT NULL REFERENCES pr_executions(id),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
