-- 服务端记录当前步骤的独立计数及暂停点；旧任务保留 NULL，继续旧预算语义。
ALTER TABLE pr_executions ADD COLUMN budget_state jsonb;

-- 多步骤 case 的调用顺序可超过旧全局 200 次；实际准入由冻结的逐步额度控制。
ALTER TABLE pr_model_calls DROP CONSTRAINT pr_model_calls_call_index_check;
ALTER TABLE pr_model_calls ADD CONSTRAINT pr_model_calls_call_index_check CHECK (call_index BETWEEN 1 AND 20000);
