-- 冻结每次线上运行的套件版本；新增场景不能改变升级前已入队任务的集合及归档口径。
ALTER TABLE pr_benchmark_runs ADD COLUMN suite text NOT NULL DEFAULT 'agent-loop-deployed-v1';
UPDATE pr_benchmark_runs SET suite='agent-loop-v2-deployed-v1' WHERE family='v2';
