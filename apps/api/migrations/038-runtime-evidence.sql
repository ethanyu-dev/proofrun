-- 同一会话的运行时事实独立归档；旧证据不重写、不补造。
ALTER TABLE pr_artifacts DROP CONSTRAINT pr_artifacts_kind_check;
ALTER TABLE pr_artifacts ADD CONSTRAINT pr_artifacts_kind_check CHECK (kind IN ('DOM','SCREENSHOT','NETWORK','TRACE','RUNTIME'));
