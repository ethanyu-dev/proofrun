-- 通知进度绑定一次人工介入，轮换过期链接不会导致同一请求再次通知。
-- 不保存 webhook、签名密钥或完整处理链接；重新部署后继续有界重试。
ALTER TABLE pr_interventions
  ADD COLUMN feishu_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN feishu_next_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN feishu_sent_at timestamptz;

CREATE INDEX pr_interventions_feishu_pending ON pr_interventions(feishu_next_at)
  WHERE feishu_sent_at IS NULL AND completed_at IS NULL AND feishu_attempts < 5;
