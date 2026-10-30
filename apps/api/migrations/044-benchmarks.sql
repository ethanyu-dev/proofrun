-- 运行身份与发布版本分开；重复版本允许多次运行，客户端重送同一身份不重复创建任务。
CREATE TABLE pr_benchmark_runs (
 id text PRIMARY KEY,
 release jsonb NOT NULL,
 environment text NOT NULL,
 state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 deadline_at timestamptz NOT NULL,
 archive jsonb
);
CREATE INDEX pr_benchmark_versions ON pr_benchmark_runs((release->>'version'),created_at DESC,id DESC);
CREATE UNIQUE INDEX pr_benchmark_one_active ON pr_benchmark_runs((true)) WHERE state IN ('QUEUED','RUNNING');
-- 真值由站点 HTTP 请求写入，模型不能用报告覆盖它；组件身份在执行时冻结。
CREATE TABLE pr_benchmark_cases (
 task_id text PRIMARY KEY REFERENCES pr_tasks(id),
 run_id text NOT NULL REFERENCES pr_benchmark_runs(id),
 scenario text NOT NULL,
 visits integer NOT NULL DEFAULT 0,
 writes jsonb NOT NULL DEFAULT '[]',
 injected boolean NOT NULL DEFAULT false,
 stale_rejected boolean NOT NULL DEFAULT false,
 api_release jsonb,
 agent_release jsonb,
 model_config jsonb,
 UNIQUE(run_id,scenario)
);
-- 单独记录执行器收到的回执，原生回执仍保存在 pr_commands，故障注入不覆盖生产事实。
CREATE TABLE pr_benchmark_commands (
 command_id text PRIMARY KEY,
 task_id text NOT NULL REFERENCES pr_benchmark_cases(task_id),
 record jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
