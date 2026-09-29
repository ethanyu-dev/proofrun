-- 人工操作与自动执行共享原会话及租约；代次阻断已过期的模型决定与控制台请求。
ALTER TABLE pr_executions ADD COLUMN control_mode text NOT NULL DEFAULT 'AUTO' CHECK(control_mode IN ('AUTO','REQUESTED','HUMAN'));
ALTER TABLE pr_executions ADD COLUMN control_revision integer NOT NULL DEFAULT 0;
ALTER TABLE pr_executions ADD COLUMN control_reason text;
ALTER TABLE pr_commands ADD COLUMN actor text NOT NULL DEFAULT 'AGENT' CHECK(actor IN ('AGENT','HUMAN'));
CREATE TABLE pr_control_events (
 id bigserial PRIMARY KEY,
 execution_id text NOT NULL REFERENCES pr_executions(id),
 mode text NOT NULL,
 revision integer NOT NULL,
 reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX pr_control_history ON pr_control_events(execution_id,id);

-- 网络证据以脱敏后的 JSON 元数据存入数据库。
ALTER TABLE pr_artifacts DROP CONSTRAINT pr_artifacts_kind_check;
ALTER TABLE pr_artifacts ADD CONSTRAINT pr_artifacts_kind_check CHECK(kind IN ('DOM','SCREENSHOT','NETWORK'));

ALTER TABLE pr_tasks ADD COLUMN archived_at timestamptz;

-- 原配对码在有效期内只能取回同一节点的相同回执，不能绑定第二个节点。
ALTER TABLE pr_pairings ADD COLUMN paired_node_id text;
ALTER TABLE pr_pairings ADD COLUMN rotate_node_id text REFERENCES pr_nodes(id);
