-- 报告复盘已退役，删除历史分析内容、队列租约与调用用量；所属索引随表删除。
-- 不使用 CASCADE，避免意外删除验证请求、执行记录或其他依赖对象。
DROP TABLE pr_analysis_calls;
DROP TABLE pr_request_analyses;
