-- 人工等待独立于业务预算与链接有效期；历史 NULL 不回填，避免追溯误判超时。
ALTER TABLE pr_executions ADD COLUMN human_requested_at timestamptz;
ALTER TABLE pr_executions ADD COLUMN human_deadline_at timestamptz;
CREATE INDEX pr_human_deadline ON pr_executions(human_deadline_at) WHERE state='RUNNING' AND control_mode<>'AUTO';
-- 节点原始关闭原因独立保存，关闭确认和后续清理重试不能覆盖。
ALTER TABLE pr_sessions ADD COLUMN close_reason text;
