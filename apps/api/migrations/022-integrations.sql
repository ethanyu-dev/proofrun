-- 调用者归属与绑定快照和 case 拆组在同一事务提交；不保存任何服务凭据。
CREATE TABLE pr_integration_cases (
  case_id text PRIMARY KEY,
  task_id text NOT NULL UNIQUE REFERENCES pr_tasks(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  task_ids text[] NOT NULL,
  client_id text NOT NULL,
  context jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX pr_integration_case_tasks ON pr_integration_cases USING gin(task_ids);
-- 链接可以轮换，人工请求身份不能跟着链接身份改变。
ALTER TABLE pr_interventions ADD COLUMN request_id text NOT NULL DEFAULT gen_random_uuid()::text;
CREATE UNIQUE INDEX pr_intervention_request ON pr_interventions(request_id);
CREATE TABLE pr_notification_aggregates (
  id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES pr_integration_cases(case_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('hitl','case')),
  sequence integer NOT NULL,
  snapshot jsonb NOT NULL
);
-- 信封没有 HITL 凭据或 URL，重试永远复用原 event_id 和 payload。
CREATE TABLE pr_notification_outbox (
  event_id text PRIMARY KEY,
  aggregate_id text NOT NULL REFERENCES pr_notification_aggregates(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','retrying','delivered','unknown','failed','superseded')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  receipt jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(aggregate_id,sequence)
);
CREATE INDEX pr_notification_due ON pr_notification_outbox(next_attempt_at) WHERE status IN ('pending','accepted','retrying');

-- 只在聚合视图变化时生成事件；调用方已经按 case 行串行化，避免多组重复终态。
CREATE FUNCTION pr_emit_notification(binding pr_integration_cases, aggregate_id text, aggregate_kind text, snapshot jsonb, event_type text, extra jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE previous pr_notification_aggregates; next_sequence integer; event_id text;
BEGIN
  SELECT * INTO previous FROM pr_notification_aggregates WHERE id=aggregate_id;
  IF FOUND AND previous.snapshot=snapshot THEN RETURN; END IF;
  -- 一次人工请求完成后不能被后续任务终态改写为另一种处理结论。
  IF previous.snapshot->>'state' IN ('RESOLVED','CLOSED','FINISHED') THEN RETURN; END IF;
  next_sequence := COALESCE(previous.sequence,0)+1;
  IF aggregate_kind='hitl' AND snapshot->>'state' IN ('REQUESTED','HUMAN') THEN
    event_type := CASE WHEN previous.id IS NULL THEN 'hitl.requested' ELSE 'hitl.updated' END;
  END IF;
  INSERT INTO pr_notification_aggregates(id,case_id,kind,sequence,snapshot)
  VALUES(aggregate_id,binding.case_id,aggregate_kind,next_sequence,snapshot)
  ON CONFLICT(id) DO UPDATE SET sequence=EXCLUDED.sequence,snapshot=EXCLUDED.snapshot;
  event_id := gen_random_uuid()::text;
  INSERT INTO pr_notification_outbox(event_id,aggregate_id,sequence,payload)
  VALUES(event_id,aggregate_id,next_sequence,jsonb_build_object(
    'schemaVersion','proofrun.notification.v1','eventId',event_id,'type',event_type,
    'occurredAt',clock_timestamp(),'integrationId',binding.context->>'integrationId',
    'bindingRef',binding.context->>'bindingRef','bindingVersion',binding.context->'bindingVersion',
    'caseId',binding.case_id,'aggregate',jsonb_build_object('kind',aggregate_kind,'id',aggregate_id,'sequence',next_sequence)
  ) || extra);
END $$;

-- 延迟到业务事务提交前读取最终状态，覆盖人工交还、无法执行、取消和租约终止的所有入口。
CREATE FUNCTION pr_project_notifications() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected_task_id text; binding pr_integration_cases; request record; state text; snapshot jsonb;
BEGIN
  IF TG_TABLE_NAME='pr_tasks' THEN affected_task_id:=NEW.id;
  ELSIF TG_TABLE_NAME='pr_executions' THEN affected_task_id:=NEW.task_id;
  ELSE SELECT e.task_id INTO affected_task_id FROM pr_executions e WHERE e.id=NEW.execution_id;
  END IF;
  SELECT b.* INTO binding FROM pr_integration_cases b WHERE b.task_ids @> ARRAY[affected_task_id] FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  FOR request IN
    SELECT i.*,e.task_id,e.control_mode,e.control_revision,e.control_reason,e.state AS execution_state,
      t.state AS task_state,t.definition,t.error, s.state AS session_state
    FROM pr_interventions i JOIN pr_executions e ON e.id=i.execution_id
    JOIN pr_tasks t ON t.id=e.task_id LEFT JOIN pr_sessions s ON s.execution_id=e.id
    WHERE e.task_id=ANY(binding.task_ids)
  LOOP
    state:=CASE
      WHEN request.unable_reason IS NOT NULL THEN 'CLOSED'
      WHEN request.completed_at IS NOT NULL THEN 'RESOLVED'
      WHEN request.task_state<>'RUNNING' OR request.execution_state<>'RUNNING'
        OR request.session_state IS DISTINCT FROM 'ACTIVE'
        OR request.revision<>request.control_revision OR request.control_mode='AUTO' THEN 'CLOSED'
      ELSE request.control_mode END;
    snapshot:=jsonb_build_object('state',state,'taskId',request.task_id,'executionId',request.execution_id,
      'grantId',request.id,'expiresAt',request.expires_at,'items',request.items,
      'reason',CASE WHEN state='CLOSED' THEN COALESCE(request.unable_reason,request.error->>'code',CASE WHEN request.task_state<>'RUNNING' THEN request.task_state ELSE 'SESSION_OR_CONTROL_ENDED' END) ELSE COALESCE(request.reason_code,request.control_reason) END,'title',COALESCE(request.definition#>>'{caseV2Definition,description}','测试需要人工处理'));
    PERFORM pr_emit_notification(binding,request.request_id,'hitl',snapshot,
      CASE WHEN state='RESOLVED' THEN 'hitl.resolved' ELSE 'hitl.closed' END,
      jsonb_build_object('taskId',request.task_id,'executionId',request.execution_id,'arm',COALESCE(request.definition#>>'{comparison,arm}',request.definition->>'executionMode','llm')));
  END LOOP;
  IF binding.context->'events' ? 'case.finished' AND NOT EXISTS(
    SELECT 1 FROM pr_tasks t WHERE t.id=ANY(binding.task_ids) AND t.state IN ('QUEUED','RUNNING')
  ) THEN
    PERFORM pr_emit_notification(binding,'case:' || binding.case_id,'case',jsonb_build_object('state','FINISHED'), 'case.finished','{}'::jsonb);
  END IF;
  RETURN NULL;
END $$;

-- 仅业务状态字段变化触发，避免 worker 心跳和租约续期生成无效事件。
CREATE CONSTRAINT TRIGGER pr_notify_intervention AFTER INSERT OR UPDATE ON pr_interventions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pr_project_notifications();
CREATE CONSTRAINT TRIGGER pr_notify_execution AFTER UPDATE OF state,control_mode,control_revision ON pr_executions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pr_project_notifications();
CREATE CONSTRAINT TRIGGER pr_notify_task AFTER UPDATE OF state ON pr_tasks
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pr_project_notifications();
CREATE CONSTRAINT TRIGGER pr_notify_session AFTER UPDATE OF state ON pr_sessions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pr_project_notifications();
