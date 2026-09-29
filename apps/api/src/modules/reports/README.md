# 报告与证据

artifacts.ts 负责 DOM 归档、PNG 流式上传和存储确认、标准覆盖及证据归属校验。报告不能引用其他执行的证据，确定结论必须包含要求的证据种类。证据存在不能代替页面业务判定。

`model-calls.ts` 保存每次真实模型请求正文及回复。worker 通过执行专属凭据先提交请求、再补交回执；相同身份可幂等重送但不能改写原文。管理员通过 `/v1/admin/executions/:id/model-calls` 读取元数据列表，通过 `/:callId` 按需读取正文。记录中的 RECEIVED 仅表示收到供应商回复，不表示决定有效或业务通过。旧任务不补造请求记录；正文随任务证据的保留策略清理。

## 网络证据边界

要求 NETWORK 的任务只能分配到声明 networkEvidence 的节点。记录包含去除账号、查询参数和片段的 URL、method、status、resourceType、timestamp；没有 Cookie、认证头、请求体和响应体。单次最多 100 条，证据明确标记窗口、截断和非完整捕获。网络日志在每次观察后清空，尚未收到状态码的请求可能为 null；不得根据日志缺失断言网络调用从未发生，也不能据此证明服务端只写入一次。

该实现核对固定版本 [agent-browser 0.38.1 原生请求实现](https://github.com/vercel-labs/agent-browser/blob/v0.38.1/cli/src/native/actions.rs) 和 [存储状态实现](https://github.com/vercel-labs/agent-browser/blob/v0.38.1/cli/src/native/state.rs)，继续保持版本固定，不随文档最新版本自动升级。
