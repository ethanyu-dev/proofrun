-- 请求只保存不可变归属；执行状态和报告仍由原任务持有。
CREATE TABLE pr_verification_requests (
  request_id text PRIMARY KEY,
  title text NOT NULL,
  definition_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_request_id text REFERENCES pr_verification_requests(request_id),
  rerun_parameters jsonb
);
CREATE TABLE pr_verification_request_cases (
  request_id text NOT NULL REFERENCES pr_verification_requests(request_id),
  case_id text NOT NULL,
  task_id text NOT NULL REFERENCES pr_tasks(id),
  position integer NOT NULL CHECK (position >= 0),
  definition_hash text NOT NULL,
  execution_origin text NOT NULL CHECK (execution_origin IN ('created','reused')),
  source_case_id text,
  PRIMARY KEY (request_id, case_id),
  UNIQUE (request_id, position)
);
CREATE INDEX pr_request_case_reverse ON pr_verification_request_cases(case_id);
CREATE INDEX pr_request_task_reverse ON pr_verification_request_cases(task_id);
CREATE INDEX pr_request_page ON pr_verification_requests(created_at DESC, request_id DESC);
CREATE TABLE pr_verification_request_arms (
  request_id text NOT NULL,
  case_id text NOT NULL,
  execution_mode text NOT NULL CHECK (execution_mode IN ('llm','jev')),
  task_id text NOT NULL REFERENCES pr_tasks(id),
  PRIMARY KEY (request_id, case_id, execution_mode),
  FOREIGN KEY (request_id, case_id) REFERENCES pr_verification_request_cases(request_id, case_id)
);
CREATE INDEX pr_request_arm_reverse ON pr_verification_request_arms(task_id);
