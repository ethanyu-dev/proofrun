-- 控制权与认证环境分别计数；历史执行不迁移旧确认的有效性。
ALTER TABLE pr_executions ADD COLUMN auth_revision integer NOT NULL DEFAULT 0;
ALTER TABLE pr_interventions ADD COLUMN condition_keys jsonb;
ALTER TABLE pr_interventions ADD COLUMN confirmed_condition_keys jsonb;
ALTER TABLE pr_interventions ADD COLUMN auth_revision integer;
