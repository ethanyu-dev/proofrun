# 历史执行对照

新建任务只支持 llm，JEV 与 parallel 已退役。新建对照接口返回 410；Case profile 或任务显式要求旧模式时拒绝创建。Console 不再提供新建双跑按钮。

已有对照的任务、报告、用量和差异仍可读取。历史记录不会被改写为单组任务，也不会删除其证据。对历史任务点击重跑会创建新的 llm 执行，不重新生成旧对照。

当前循环、上下文和身份迁移见 [Agent 简化架构](agent-loop-simplification-design.md)。新版本效果对比使用 [端到端测评](../tests/scenarios/README.md)，不依赖已退役的 JEV 运行路径。
