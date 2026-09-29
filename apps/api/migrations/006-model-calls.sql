-- 每次供应商请求单独存档；决策轮次与实际调用顺序区分混合策略及重试。
CREATE TABLE pr_model_calls (
  id text PRIMARY KEY,
  execution_id text NOT NULL REFERENCES pr_executions(id),
  call_index integer NOT NULL CHECK(call_index BETWEEN 1 AND 200),
  record jsonb NOT NULL,
  start_hash text NOT NULL,
  finish_hash text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(execution_id,call_index)
);
CREATE INDEX pr_model_calls_execution ON pr_model_calls(execution_id,call_index);
