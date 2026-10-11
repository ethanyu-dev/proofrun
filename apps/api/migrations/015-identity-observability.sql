-- 用固定分类统计人工介入，不扫描或公开含业务信息的自由文本。
ALTER TABLE pr_interventions ADD COLUMN reason_code text NOT NULL DEFAULT 'GENERAL';
-- 结束时间只由控制面接收/合成回执时登记，不接受 worker 自报耗时。
ALTER TABLE pr_commands ADD COLUMN completed_at timestamptz;
CREATE INDEX pr_identity_preparations ON pr_commands(created_at) WHERE kind='browser.identity.prepare';
