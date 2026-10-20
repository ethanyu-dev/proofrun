-- 分析每次真实调用独立保留，重跑和租约恢复不会清零已发生的用量。
CREATE TABLE pr_analysis_calls (
  request_id text NOT NULL REFERENCES pr_verification_requests(request_id),
  call_id text NOT NULL,
  revision text NOT NULL,
  token_hash text NOT NULL,
  model text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('review','final')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RECEIVED','ERROR')),
  prompt_tokens bigint CHECK (prompt_tokens >= 0),
  completion_tokens bigint CHECK (completion_tokens >= 0),
  elapsed_ms bigint CHECK (elapsed_ms >= 0),
  error text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  start_hash text NOT NULL,
  finish_hash text,
  PRIMARY KEY (request_id,call_id)
);
CREATE INDEX pr_analysis_calls_revision ON pr_analysis_calls(request_id,revision);
