-- TRACE 与截图共享可靠交付流程；正文仍为独立 JSON 文件。
ALTER TABLE pr_artifacts DROP CONSTRAINT pr_artifacts_kind_check;
ALTER TABLE pr_artifacts ADD CONSTRAINT pr_artifacts_kind_check CHECK(kind IN ('DOM','SCREENSHOT','NETWORK','TRACE'));
