-- 外部执行与内置领取隔离；旧任务和原冻结版本不变。
ALTER TABLE pr_tasks DROP CONSTRAINT pr_tasks_executor_kind_check;
ALTER TABLE pr_tasks ADD CONSTRAINT pr_tasks_executor_kind_check CHECK(executor_kind IN ('builtin','external'));
ALTER TABLE pr_tasks ADD COLUMN binding_deadline_at timestamptz;

-- 控制句柄不是凭据，只能由已登记的 principal 使用；内部令牌不落在公开记录中。
CREATE TABLE pr_external_controllers (
  id text PRIMARY KEY,
  run_id text NOT NULL UNIQUE REFERENCES pr_tasks(id),
  principal_id text NOT NULL,
  state text NOT NULL CHECK(state IN ('ACTIVE','CLOSED','EXPIRED','LOST')),
  execution_id text UNIQUE REFERENCES pr_executions(id),
  revision bigint NOT NULL DEFAULT 0,
  context jsonb,
  control_revision bigint,
  auth_revision bigint,
  idle_deadline_at timestamptz NOT NULL,
  decision_calls integer NOT NULL DEFAULT 0,
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- 先登记操作再唤醒共享执行器。重复提交仅返回原记录，未知效果不能被重新派发。
CREATE TABLE pr_external_operations (
  principal_id text NOT NULL,
  id text NOT NULL,
  input_hash text NOT NULL,
  controller_id text REFERENCES pr_external_controllers(id),
  run_id text NOT NULL REFERENCES pr_tasks(id),
  kind text NOT NULL,
  state text NOT NULL CHECK(state IN ('RUNNING','SUCCEEDED','FAILED','UNKNOWN')),
  progress_applied boolean NOT NULL DEFAULT false,
  command_ids jsonb NOT NULL DEFAULT '[]',
  error_code text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(principal_id,id)
);
CREATE UNIQUE INDEX pr_external_one_pending ON pr_external_operations(controller_id) WHERE state='RUNNING';
