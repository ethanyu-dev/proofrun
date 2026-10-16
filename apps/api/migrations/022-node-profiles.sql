-- 节点模板维护复用持久执行、命令与关闭确认，但不进入业务任务列表或身份库。
CREATE TABLE pr_node_profiles (
  id text PRIMARY KEY REFERENCES pr_interventions(id),
  task_id text NOT NULL UNIQUE REFERENCES pr_tasks(id),
  node_id text NOT NULL REFERENCES pr_nodes(id),
  save_status text CHECK (save_status IN ('saved','newer')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX pr_node_profiles_node ON pr_node_profiles(node_id,created_at DESC);
