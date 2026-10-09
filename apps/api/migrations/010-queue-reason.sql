-- 调度诊断独立于不可变任务定义和业务报告；领取后清空，到期保留最后一次检查结果。
ALTER TABLE pr_tasks ADD COLUMN queue_reason jsonb;
