-- 日统计按服务端时间限定读取范围，不依赖请求成员或前端分页。
CREATE INDEX pr_model_calls_created ON pr_model_calls(created_at);
CREATE INDEX pr_analysis_calls_started ON pr_analysis_calls(started_at);
CREATE INDEX pr_tasks_finished_usage ON pr_tasks(finished_at) WHERE report ? 'executionDetails';
-- 先选周期内候选，再补齐跨午夜的双跑组；历史数据量增加时无需全表分组。
CREATE INDEX pr_tasks_statistics_created ON pr_tasks(created_at);
CREATE INDEX pr_tasks_statistics_identity ON pr_tasks((coalesce('comparison:' || (definition#>>'{comparison,id}'), 'task:' || id)));
