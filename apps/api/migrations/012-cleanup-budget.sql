-- 清理阶段只启动一次独立时钟；重复写入步骤或重启控制面不能重新获得预算。
ALTER TABLE pr_tasks ADD COLUMN cleanup_deadline_at timestamptz;
