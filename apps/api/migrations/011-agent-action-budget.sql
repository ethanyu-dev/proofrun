-- 旧版 action_count 混入了人工操作。只校准活动执行，保留终态历史与报告原貌。
-- 按已持久化的 Agent 命令重算，包含已失败但已准入的动作；命令去重保证不重复扣费。
UPDATE pr_executions e SET action_count = (
  SELECT count(*) FROM pr_commands c
  WHERE c.execution_id=e.id AND c.actor='AGENT' AND c.kind='browser.act'
) WHERE e.state IN ('STARTING','RUNNING');
