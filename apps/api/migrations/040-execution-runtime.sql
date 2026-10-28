-- 旧运行保持版本 0；新运行在入队时冻结驱动版本，不能在领取时隐式升级。
ALTER TABLE pr_tasks ADD COLUMN runtime_version integer NOT NULL DEFAULT 0 CHECK(runtime_version IN (0,1));
ALTER TABLE pr_tasks ADD COLUMN executor_kind text NOT NULL DEFAULT 'builtin' CHECK(executor_kind='builtin');

-- 快照用于跨请求审计；进程丢失时关闭执行，不从快照自动重放业务动作。
CREATE TABLE pr_execution_runtimes (
  execution_id text PRIMARY KEY REFERENCES pr_executions(id),
  driver_version integer NOT NULL DEFAULT 1 CHECK(driver_version=1),
  state text NOT NULL CHECK(state IN ('ACTIVE','FINISHED','LOST')),
  config jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  snapshot jsonb,
  result_report jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- 每个分组可以等待一次决定；决定与版本不可改写，模型回执与命令各自持久化。
CREATE TABLE pr_runtime_decisions (
  id text PRIMARY KEY,
  execution_id text NOT NULL REFERENCES pr_execution_runtimes(execution_id),
  revision bigint NOT NULL,
  state text NOT NULL CHECK(state IN ('WAITING','ACCEPTED','ABORTED')),
  context jsonb NOT NULL,
  control_revision bigint NOT NULL,
  auth_revision bigint NOT NULL,
  trace_start_hash text,
  trace_finish_hash text,
  trace_start_done boolean NOT NULL DEFAULT false,
  trace_finish_done boolean NOT NULL DEFAULT false,
  input_hash text,
  outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(execution_id,revision)
);
CREATE INDEX pr_runtime_waiting ON pr_runtime_decisions(execution_id,revision) WHERE state='WAITING';

-- 操作意图先持久化，实际派发仍复用 pr_commands 的原子准入与节点幂等。
CREATE TABLE pr_runtime_operations (
  command_id text PRIMARY KEY,
  execution_id text NOT NULL REFERENCES pr_execution_runtimes(execution_id),
  input_hash text NOT NULL,
  intent jsonb NOT NULL,
  result jsonb,
  state text NOT NULL CHECK(state IN ('PENDING','DISPATCHED','FINISHED','ABORTED','UNKNOWN')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
