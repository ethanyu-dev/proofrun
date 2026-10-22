-- 摘要可从任务与冻结归属重建；原始记录始终是事实来源。
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE pr_request_summaries (
  request_id text PRIMARY KEY REFERENCES pr_verification_requests(request_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  summary jsonb NOT NULL,
  -- 每个字段独立匹配，不能让查询词跨越两个成员产生假命中。
  search_terms text[] NOT NULL,
  -- 拼接文本只用于 trigram 粗筛，仍按独立字段复核，不能改变原有子串搜索语义。
  search_text text NOT NULL,
  execution_status text GENERATED ALWAYS AS (summary->>'executionStatus') STORED,
  report_status text GENERATED ALWAYS AS (summary->>'reportStatus') STORED
);
CREATE INDEX pr_request_summary_page ON pr_request_summaries(created_at DESC,request_id DESC);
CREATE INDEX pr_request_summary_execution ON pr_request_summaries(execution_status,created_at DESC,request_id DESC);
CREATE INDEX pr_request_summary_report ON pr_request_summaries(report_status,created_at DESC,request_id DESC);
CREATE INDEX pr_request_summary_both ON pr_request_summaries(execution_status,report_status,created_at DESC,request_id DESC);
CREATE INDEX pr_request_summary_search ON pr_request_summaries USING gin(search_text gin_trgm_ops);

-- 标记与业务变更原子提交；每次冲突也更新行版本，保证可重复读刷新能发现并发写入。
CREATE TABLE pr_request_summary_dirty (
  request_id text PRIMARY KEY REFERENCES pr_verification_requests(request_id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1
);
CREATE FUNCTION pr_mark_request_summary(id text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO pr_request_summary_dirty(request_id) VALUES(id)
  ON CONFLICT(request_id) DO UPDATE SET revision=pr_request_summary_dirty.revision+1;
$$;
CREATE FUNCTION pr_invalidate_request_summary() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN PERFORM pr_mark_request_summary(OLD.request_id); END IF;
  IF TG_OP <> 'DELETE' AND (TG_OP='INSERT' OR NEW.request_id IS DISTINCT FROM OLD.request_id) THEN
    PERFORM pr_mark_request_summary(NEW.request_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER pr_request_summary_created AFTER INSERT OR UPDATE OF created_at,title ON pr_verification_requests
  FOR EACH ROW EXECUTE FUNCTION pr_invalidate_request_summary();
CREATE TRIGGER pr_request_summary_members AFTER INSERT OR UPDATE OR DELETE ON pr_verification_request_cases
  FOR EACH ROW EXECUTE FUNCTION pr_invalidate_request_summary();
CREATE TRIGGER pr_request_summary_arms AFTER INSERT OR UPDATE OR DELETE ON pr_verification_request_arms
  FOR EACH ROW EXECUTE FUNCTION pr_invalidate_request_summary();

-- 所有状态写入路径自动覆盖，包括超时、取消、共享 Case 和报告补交；心跳与用量更新不触发。
CREATE FUNCTION pr_invalidate_task_requests() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pr_request_summary_dirty(request_id)
    SELECT DISTINCT request_id FROM pr_verification_request_arms WHERE task_id=NEW.id ORDER BY request_id
  ON CONFLICT(request_id) DO UPDATE SET revision=pr_request_summary_dirty.revision+1;
  RETURN NULL;
END $$;
CREATE TRIGGER pr_task_request_summary AFTER UPDATE OF state,report,definition ON pr_tasks
  FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state OR OLD.report IS DISTINCT FROM NEW.report OR OLD.definition IS DISTINCT FROM NEW.definition)
  EXECUTE FUNCTION pr_invalidate_task_requests();

-- 启动时按小事务回填，迁移内不复制业务判定逻辑，也不把未知状态填成成功。
INSERT INTO pr_request_summary_dirty(request_id) SELECT request_id FROM pr_verification_requests;
