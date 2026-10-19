-- 独立分析队列在 API/worker 重启后保留；验收报告原文不被总结覆盖。
CREATE TABLE pr_request_analyses (
  request_id text PRIMARY KEY REFERENCES pr_verification_requests(request_id),
  revision text NOT NULL,
  status text NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  snapshot jsonb NOT NULL,
  summary text,
  error text,
  model text,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  generated_at timestamptz,
  token_hash text,
  lease_until timestamptz,
  started_at timestamptz,
  attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX pr_analysis_queue ON pr_request_analyses(requested_at) WHERE status IN ('QUEUED','RUNNING');
