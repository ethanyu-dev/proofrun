-- 人工勾选结果独立于“交还控制权”；管理员直接 resume 不会伪造逐项确认。
ALTER TABLE pr_interventions ADD COLUMN confirmed_items jsonb;
