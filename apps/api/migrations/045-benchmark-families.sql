-- 旧运行默认仍属基础套件；V2 单独筛选但共用既有全局并发围栏与通知排除关系。
ALTER TABLE pr_benchmark_runs ADD COLUMN family text NOT NULL DEFAULT 'browser' CHECK(family IN ('browser','v2'));
CREATE INDEX pr_benchmark_family_versions ON pr_benchmark_runs(family,(release->>'version'),created_at DESC,id DESC);
-- 冻结来源元信息，后续发布修改固定套件时仍能重建在途运行的原定义。
ALTER TABLE pr_benchmark_cases ADD COLUMN source jsonb;
