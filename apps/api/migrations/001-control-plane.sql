-- 控制面拥有全局事实；节点本机 SQLite 只保存执行和恢复事实。
CREATE TABLE pr_nodes (
  id text PRIMARY KEY,
  name text NOT NULL,
  pool text NOT NULL,
  credential_hash text NOT NULL UNIQUE,
  revoked_at timestamptz,
  node_epoch text,
  capacity integer NOT NULL DEFAULT 0 CHECK (capacity BETWEEN 0 AND 32),
  capabilities jsonb NOT NULL DEFAULT '{}',
  inventory jsonb NOT NULL DEFAULT '[]',
  fence bigint NOT NULL DEFAULT 0 CHECK (fence BETWEEN 0 AND 9007199254740991),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE pr_pairings (
  token_hash text PRIMARY KEY,
  pool text NOT NULL,
  name text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE TABLE pr_tasks (
  id text PRIMARY KEY,
  definition jsonb NOT NULL,
  definition_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('QUEUED','RUNNING','COMPLETED','CANCELLED','TIMED_OUT','ERROR')),
  deadline_at timestamptz NOT NULL,
  report jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz
);
-- 按在线资源池取队首，离线池的大量积压不会增加每次领取的扫描范围。
CREATE INDEX pr_task_queue ON pr_tasks((definition#>>'{environment,nodePool}'),created_at,id) WHERE state='QUEUED';
CREATE TABLE pr_executions (
  id text PRIMARY KEY,
  task_id text NOT NULL UNIQUE REFERENCES pr_tasks(id),
  worker_id text NOT NULL,
  token_hash text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('STARTING','RUNNING','STOPPING','FINISHED')),
  action_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz
);
CREATE TABLE pr_sessions (
  id text PRIMARY KEY,
  execution_id text NOT NULL UNIQUE REFERENCES pr_executions(id),
  node_id text NOT NULL REFERENCES pr_nodes(id),
  node_epoch text NOT NULL,
  lease_id text NOT NULL,
  fence bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('OPENING','ACTIVE','CLOSING','CLOSED','QUARANTINED')),
  closure_verified boolean NOT NULL DEFAULT false,
  last_renew_request text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz
);
CREATE INDEX pr_node_occupied ON pr_sessions(node_id) WHERE NOT closure_verified;
CREATE TABLE pr_commands (
  id text PRIMARY KEY,
  execution_id text NOT NULL REFERENCES pr_executions(id),
  session_id text NOT NULL REFERENCES pr_sessions(id),
  node_id text NOT NULL REFERENCES pr_nodes(id),
  kind text NOT NULL,
  request_hash text NOT NULL,
  envelope jsonb NOT NULL,
  deadline_at timestamptz NOT NULL,
  first_sent_at timestamptz,
  next_delivery_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- 同一会话仅允许一条未结束的浏览器操作；续期和关闭不受该约束阻塞。
CREATE UNIQUE INDEX pr_one_browser_command ON pr_commands(session_id)
  WHERE result IS NULL AND kind LIKE 'browser.%';
CREATE INDEX pr_command_delivery ON pr_commands(next_delivery_at) WHERE result IS NULL;
CREATE TABLE pr_node_inbox (
  node_id text NOT NULL REFERENCES pr_nodes(id),
  message_id text NOT NULL,
  payload_hash text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(node_id,message_id)
);
CREATE TABLE pr_artifacts (
  id text PRIMARY KEY,
  node_id text NOT NULL REFERENCES pr_nodes(id),
  execution_id text NOT NULL REFERENCES pr_executions(id),
  session_id text NOT NULL REFERENCES pr_sessions(id),
  command_id text NOT NULL REFERENCES pr_commands(id),
  kind text NOT NULL CHECK (kind IN ('DOM','SCREENSHOT')),
  hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','STORED','AVAILABLE')),
  size bigint,
  content jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  stored_at timestamptz
);
