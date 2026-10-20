# 报告与证据

artifacts.ts 负责 DOM 归档、PNG 流式上传和存储确认、标准覆盖及证据归属校验。报告不能引用其他执行的证据，确定结论必须包含要求的证据种类。证据存在不能代替页面业务判定。

`model-calls.ts` 保存每次真实模型请求正文及回复。worker 通过执行专属凭据先提交请求、再补交回执；相同身份可幂等重送但不能改写原文。管理员通过 `/v1/admin/executions/:id/model-calls` 读取元数据列表，通过 `/:callId` 按需读取正文。记录中的 RECEIVED 仅表示收到供应商回复，不表示决定有效或业务通过。旧任务不补造请求记录；正文随任务证据的保留策略清理。

## 网络证据边界

要求 NETWORK 的任务只能分配到声明 networkEvidence 的节点。记录包含去除账号、查询参数和片段的 URL、method、status、resourceType、timestamp；没有 Cookie、认证头、请求体和响应体。原生 CDP 按 tab 保留最多 500 条元数据，观察不清空历史，只交付当前主文档 navigationId 的记录。旧引擎回退最多 100 条且不具备 tab-navigation 范围，不能满足固定接口检查。证据明确标记截断和非完整捕获，尚未收到状态码的请求可能为 null；不得根据日志缺失断言网络调用从未发生，也不能据此证明服务端只写入一次。

该实现核对固定版本 [agent-browser 0.38.1 原生请求实现](https://github.com/vercel-labs/agent-browser/blob/v0.38.1/cli/src/native/actions.rs) 和 [存储状态实现](https://github.com/vercel-labs/agent-browser/blob/v0.38.1/cli/src/native/state.rs)，继续保持版本固定，不随文档最新版本自动升级。

模型请求正文采用顶层字段白名单；`thinking` 可省略，提供时仅接受 `{"type":"enabled"}` 或 `{"type":"disabled"}`，不允许额外字段。`reasoning_effort` 可省略，提供时只接受 `low`、`high`、`max` 字符串。新增模型参数时必须同步该校验，并运行 `pnpm test:agent:integration` 验证 Agent 真实序列化正文可以先存档、再派发；仅模型适配器夹具通过不能证明控制面兼容。

JEV 的 `assets` 只接收已脱敏的 PNG 资源：`data_base64` 必须被替换为仅含 `omitted` 说明的对象，拒绝原始图片编码及额外资源字段。原图证据和派生图片摘要保留在 `state.screenshotSource`；`requestSha256` 仍对应实际发出的完整请求。

执行受阻或出错时，结构化与非结构化任务均可保留已经校验证据的独立验收结论；整体 `verdict` 仍必须为 `null`。该兼容变更不放宽附件归属、标准身份或证据类型校验，也不把部分通过视为整体完成。

## 请求报告分析

请求报告按“总体 Case 汇总 → Agent 分析 → Case 验证结果”展示。汇总采用页面当前执行组（历史双跑优先 JEV），全部验收项通过且已有最终报告才算 Case 成功；明确失败与通过并存为部分失败；未完成和证据不足独立展示。该展示统计不改写历史双组汇总协议。

`request-analysis.ts` 与 `analysis-routes.ts` 提供独立持久队列。管理员通过 `GET /v2/requests/:id/analysis` 读取，通过 `POST` 的 `{}` 幂等生成、`{"rerun":true}` 重新分析。请求全部结束后，打开报告页会自动提交首次生成；读取接口本身不触发模型。重新分析保留上一版成功内容和时间，不创建 Case 或执行浏览器动作。

Agent `serve` 每进程运行一个独立分析消费者，复用已有文本模型配置；API 不需要模型密钥。Worker 凭专用令牌读取冻结的 Case 步骤、报告与当前执行组的全部已存档模型观察/响应，连续分片复盘，再生成简洁结论。已清理观察不重建，截图引用不当成重新查看的视觉证据。分析独立续租，60 秒失联可重新领取，最多三次领取且总计不超过三十分钟；旧令牌不能回写总结。生成失败可手动重跑，模型输出截断或请求过大时不会发布局部分析。升级需要同时部署 API、Agent 和 Console，并应用 027 迁移。

## 请求用量统计

详情与导出的 `metrics` 在同一数据库快照汇总关联任务，双执行组及历史独立清理均计入，按任务身份去重；复用 Case 展示原执行记录，不声称是本次新增消耗。墙钟耗时使用首次执行领取至最后任务完成，包含组间等待、人工处理和清理，排除首次排队与异步分析，不使用子组耗时最大值。

验证 Tokens 优先聚合 `pr_model_calls` 的 usage，`JEV_SELECTION` 归 JEV，`DECISION` 与 `FIELD_VALUE` 归 LLM；没有调用记录的历史任务回退报告中的执行用量，混合模型名不猜测拆分。空用量显示横线，合计只包含已返回计数，不作为供应商完整账单；自动身份选择仍不在此验证口径内。

`analysis-calls.ts` 独立保存分析调用元数据，`POST /v1/analyses/:id/model-calls/:callId` 先登记、后回写。分片复盘及最终总结均计入，格式无效的回复也保留真实 usage；错误或缺失 usage 留空。相同身份的重送幂等，已确认回执不可覆盖；旧领取可补交自己已登记调用的回执，但不能派发新调用或覆盖新总结。`usage.current` 属于当前生成代次（含恢复），`usage.cumulative` 包含历次重跑和失败调用。历史未采集的总结不反推、不自动重跑。

Agent 输出 `report_analysis_model` JSON 日志，含 requestId、callId、阶段、模型、状态、耗时及用量，不输出原始提示词、业务观察和凭据。计量接口不可用时停止派发；回执重送不重发模型。升级先部署 API 并应用 028 迁移，再部署 Agent 与 Console。
