-- 旧节点和历史会话保持 null，不用当前部署版本回填未知的运行事实。
ALTER TABLE pr_nodes ADD COLUMN runtime jsonb;
ALTER TABLE pr_sessions ADD COLUMN node_runtime jsonb;
