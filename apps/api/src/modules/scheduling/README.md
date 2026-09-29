# 调度

coordinator.ts 在 PostgreSQL 中管理任务、队列、领取、结果与到期扫描；state.ts 集中处理停止执行和关闭确认。worker 真正领取时才预留容量。租约到期先撤权，确认关闭后再归还资源；未知写入不自动重试。
