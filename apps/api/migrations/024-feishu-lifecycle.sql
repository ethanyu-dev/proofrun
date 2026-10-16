-- 应用与群共同确定投递目的地；更换群或应用不能误更新原目的地的消息。
CREATE TABLE pr_feishu_destinations (
  id text PRIMARY KEY,
  app_id text NOT NULL,
  chat_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(app_id,chat_id)
);

-- 同一比较轮次只通知一次提交和完成，各组的 HITL/恢复仍保留独立事件。
CREATE TABLE pr_feishu_runs (
  destination_id text NOT NULL REFERENCES pr_feishu_destinations(id),
  run_key text NOT NULL,
  next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  settled_at timestamptz,
  PRIMARY KEY(destination_id,run_key)
);
CREATE INDEX pr_feishu_run_poll ON pr_feishu_runs(destination_id,next_at) WHERE settled_at IS NULL;
CREATE INDEX pr_tasks_notification_run ON pr_tasks((COALESCE(definition#>>'{comparison,id}',id)));
CREATE INDEX pr_tasks_notification_created ON pr_tasks(created_at);

-- 事件来自已有持久任务/控制权事实，唯一键避免轮询、重复请求和重启重复生成通知。
-- 初次发送视图不保存 HITL 令牌、应用密钥或访问令牌；发送时派生专属链接。
CREATE TABLE pr_feishu_messages (
  id text PRIMARY KEY,
  destination_id text NOT NULL,
  run_key text NOT NULL,
  event_key text NOT NULL,
  event jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  initial_view jsonb,
  message_id text,
  sent_at timestamptz,
  first_attempt_at timestamptz,
  send_attempts integer NOT NULL DEFAULT 0,
  send_next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_hash text,
  update_hash text,
  update_attempts integer NOT NULL DEFAULT 0,
  update_next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  uneditable boolean NOT NULL DEFAULT false,
  FOREIGN KEY(destination_id,run_key) REFERENCES pr_feishu_runs(destination_id,run_key),
  UNIQUE(destination_id,run_key,event_key)
);

-- 保留 023 的旧 webhook 发送记录供审计；新应用不能取得那些消息的更新权限。
