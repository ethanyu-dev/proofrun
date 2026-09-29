-- 列表按创建时间稳定翻页，避免游标翻页时随着页码增大不断扫描偏移。
CREATE INDEX pr_task_browse ON pr_tasks(created_at DESC,id DESC);
CREATE INDEX pr_task_state_browse ON pr_tasks(state,created_at DESC,id DESC);
