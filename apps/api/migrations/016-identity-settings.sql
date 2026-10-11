-- 页面配置覆盖部署默认值；令牌只保存私有文件的随机引用，不进入数据库与报告。
CREATE TABLE pr_identity_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision integer NOT NULL DEFAULT 0,
  mode text NOT NULL DEFAULT 'environment' CHECK (mode IN ('environment','local','http')),
  catalog jsonb,
  url text,
  token_id uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((mode='http' AND url IS NOT NULL AND token_id IS NOT NULL AND catalog IS NULL)
    OR (mode='local' AND catalog IS NOT NULL AND url IS NULL AND token_id IS NULL)
    OR (mode='environment' AND catalog IS NULL AND url IS NULL AND token_id IS NULL))
);
INSERT INTO pr_identity_settings(singleton) VALUES(true);
