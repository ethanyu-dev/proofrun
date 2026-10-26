# 报告与证据

artifacts.ts 负责 DOM 归档、PNG 流式上传和存储确认、标准覆盖及证据归属校验。报告不能引用其他执行的证据，确定结论必须包含要求的证据种类。证据存在不能代替页面业务判定。

`model-calls.ts` 保存每次真实模型请求正文及回复。worker 通过执行专属凭据先提交请求、再补交回执；相同身份可幂等重送但不能改写原文。管理员通过 `/v1/admin/executions/:id/model-calls` 读取元数据列表，通过 `/:callId` 按需读取正文。记录中的 RECEIVED 仅表示收到供应商回复，不表示决定有效或业务通过。旧任务不补造请求记录；正文随任务证据的保留策略清理。

## 网络证据边界

要求 NETWORK 的任务只能分配到声明 networkEvidence 的节点。记录包含去除账号、查询参数和片段的 URL、method、status、resourceType、timestamp；没有 Cookie、认证头、请求体和响应体。原生 CDP 按 tab 保留最多 500 条元数据，观察不清空历史，只交付当前主文档 navigationId 的记录。旧引擎回退最多 100 条且不具备 tab-navigation 范围，不能满足固定接口检查。证据明确标记截断和非完整捕获，尚未收到状态码的请求可能为 null；不得根据日志缺失断言网络调用从未发生，也不能据此证明服务端只写入一次。

该实现核对固定版本 [agent-browser 0.38.1 原生请求实现](https://github.com/vercel-labs/agent-browser/blob/v0.38.1/cli/src/native/actions.rs) 和 [存储状态实现](https://github.com/vercel-labs/agent-browser/blob/v0.38.1/cli/src/native/state.rs)，继续保持版本固定，不随文档最新版本自动升级。

模型请求正文采用顶层字段白名单；`thinking` 可省略，提供时仅接受 `{"type":"enabled"}` 或 `{"type":"disabled"}`，不允许额外字段。`reasoning_effort` 可省略，提供时只接受 `low`、`high`、`max` 字符串。新增模型参数时必须同步该校验，并运行 `pnpm test:agent:integration` 验证 Agent 真实序列化正文可以先存档、再派发；仅模型适配器夹具通过不能证明控制面兼容。

新模型调用只接受 `DECISION`，请求不再接受 JEV 专用的 `state`、`questions`、`assets`。Chat Completions 图片在 Agent 侧替换为证据引用，`requestSha256` 对应实际发出的完整请求。历史 JEV/FIELD_VALUE 调用与用量仍可读取，不允许重新写入为新调用。

执行受阻或出错时，结构化与非结构化任务均可保留已经校验证据的独立验收结论；整体 `verdict` 仍必须为 `null`。该兼容变更不放宽附件归属、标准身份或证据类型校验，也不把部分通过视为整体完成。

## 请求报告

请求报告按“总体 Case 汇总 → Case 验证结果”展示。汇总采用页面当前执行组（历史双跑优先 JEV），全部验收项通过且已有最终报告才算 Case 成功；明确失败与通过并存为部分失败；未完成和证据不足独立展示。该展示统计不改写历史双组汇总协议。

验证完成后直接读取验收结论、步骤和证据，不再生成额外的 Agent 分析。报告分析接口、Worker 消费者和分析用量字段均已移除。迁移 `037-remove-report-analysis.sql` 删除历史分析表、关联索引及全部分析数据，保留验证请求、执行记录和原始报告。旧迁移文件维持升级顺序；空库初始化完成后也不保留分析表。升级时先停止旧版 Agent，再启动新版 API 完成迁移，并部署新版 Agent 与 Console。

## 请求用量统计

详情与导出的 `metrics` 在同一数据库快照汇总关联任务，双执行组及历史独立清理均计入，按任务身份去重；复用 Case 展示原执行记录，不声称是本次新增消耗。墙钟耗时使用首次执行领取至最后任务完成，包含组间等待、人工处理和清理，排除首次排队，不使用子组耗时最大值。

验证 Tokens 优先聚合 `pr_model_calls` 的 usage，`JEV_SELECTION` 归 JEV，`DECISION` 与 `FIELD_VALUE` 归 LLM；没有调用记录的历史任务回退报告中的执行用量，混合模型名不猜测拆分。空用量显示横线，合计只包含已返回计数，不作为供应商完整账单；自动身份选择仍不在此验证口径内。
