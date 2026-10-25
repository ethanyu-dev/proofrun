-- 原请求内的每次重跑独立记录幂等摘要，旧操作重试不能回退当前运行。
CREATE TABLE pr_request_reruns (
  request_id text NOT NULL REFERENCES pr_verification_requests(request_id),
  definition_hash text NOT NULL,
  parameters jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (request_id, definition_hash)
);
