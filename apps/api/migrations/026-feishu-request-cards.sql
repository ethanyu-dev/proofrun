-- 升级后请求成员不再继续独立推送；保留旧轮次与未选中的消息供审计。
UPDATE pr_feishu_runs n SET settled_at=COALESCE(n.settled_at,clock_timestamp())
WHERE EXISTS(
  SELECT 1 FROM pr_verification_request_arms a JOIN pr_tasks t ON t.id=a.task_id
  WHERE COALESCE(t.definition#>>'{comparison,id}',t.id)=n.run_key
);

-- 已经有旧通知的请求沿用目的地。全部完成的历史请求不因升级重发；
-- 尚未完成的请求继续收敛，最终只发送一次请求级汇总报告。
INSERT INTO pr_feishu_runs(destination_id,run_key,settled_at)
SELECT d.id,'request:'||r.request_id,
  CASE WHEN NOT EXISTS(
    SELECT 1 FROM pr_verification_request_arms a JOIN pr_tasks t ON t.id=a.task_id
    WHERE a.request_id=r.request_id AND t.state IN ('QUEUED','RUNNING')
  ) THEN clock_timestamp() END
FROM pr_verification_requests r JOIN pr_feishu_destinations d ON r.created_at>=d.started_at
WHERE EXISTS(
  SELECT 1 FROM pr_verification_request_arms a JOIN pr_tasks t ON t.id=a.task_id
  JOIN pr_feishu_messages m ON m.run_key=COALESCE(t.definition#>>'{comparison,id}',t.id)
  WHERE a.request_id=r.request_id AND m.destination_id=d.id
) ON CONFLICT DO NOTHING;

-- 活动请求复用最早的提交卡片及各 case 的首次 HITL 卡片，保留 uuid、
-- 初次发送快照和回执。共享任务的旧消息只能归属一个请求，其余请求独立通知。
WITH candidates AS (
  SELECT m.id,m.destination_id,r.request_id,m.occurred_at,
    CASE WHEN m.event->>'kind'='SUBMITTED' THEN 'submitted' ELSE 'hitl:'||a.case_id END AS event_key
  FROM pr_feishu_messages m JOIN pr_tasks t ON COALESCE(t.definition#>>'{comparison,id}',t.id)=m.run_key
  JOIN pr_verification_request_arms a ON a.task_id=t.id
  JOIN pr_verification_requests r ON r.request_id=a.request_id
  JOIN pr_feishu_runs n ON n.destination_id=m.destination_id AND n.run_key='request:'||r.request_id AND n.settled_at IS NULL
  WHERE m.event->>'kind' IN ('SUBMITTED','HITL')
), owned AS (
  SELECT DISTINCT ON(id) * FROM candidates ORDER BY id,request_id,event_key
), chosen AS (
  SELECT DISTINCT ON(destination_id,request_id,event_key) * FROM owned
  ORDER BY destination_id,request_id,event_key,occurred_at,id
)
UPDATE pr_feishu_messages m SET run_key='request:'||c.request_id,event_key=c.event_key,
  event=jsonb_set(m.event,'{key}',to_jsonb(c.event_key))
FROM chosen c WHERE m.id=c.id AND NOT EXISTS(
  SELECT 1 FROM pr_feishu_messages existing WHERE existing.destination_id=c.destination_id
  AND existing.run_key='request:'||c.request_id AND existing.event_key=c.event_key
);
