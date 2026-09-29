# Browser Node 0.1 协议

这是首版实现的节点协议；不包含任务分析、验收标准或 LLM 配置。源文件为 `contracts/schemas/node-command.schema.json` 和 `node-event.schema.json`。TS 类型与 Rust 命令类型从相同源文件生成，两个入口都执行 Schema 校验；业务身份与期限另做校验。

## 连接与租约

Node 主动连接配置中的 gateway_url，使用 `Authorization: Bearer <token>`。非 loopback 地址强制 WSS；不开放业务监听端口。连接成功即发送 node.heartbeat，之后每 5 秒发送。网关须回应 ACK、Ping 或业务消息；30 秒没有收到任何消息则重连，退避 1–15 秒。

心跳包含 nodeId、每次启动变化的 nodeEpoch、pool、capacity、occupied、能力声明、limits（maxLeaseMs / maxSessionMs）和 leaseRequestId。关闭中的会话与 QUARANTINED 会话仍计入占用。控制面拥有全局队列和节点注册表，心跳只是节点事实。

session.open / session.renew 必须回传最近心跳的 leaseRequestId 和 leaseTtlMs。期限从**节点发出该心跳的 CLOCK_BOOTTIME** 起算，网络延迟消耗 TTL；晚到的授权不能获得新的完整期限。续期可与浏览器操作并行，但不能复活已过期会话，也不能超过会话硬期限。

## 命令

传输一条 JSON 命令，或包装成 `{"type":"command","command":<命令>}`。单帧和单消息上限 2 MiB。

```json
{
  "protocolVersion": "0.1",
  "commandId": "cmd-001",
  "nodeId": "心跳中的节点身份",
  "nodeEpoch": "心跳中的启动身份",
  "sessionId": "run-001",
  "leaseId": "lease-001",
  "fence": 1,
  "timeoutMs": 15000,
  "command": {
    "type": "session.open",
    "leaseRequestId": "最近心跳中的授权请求身份",
    "leaseTtlMs": 60000,
    "maxDurationMs": 120000
  }
}
```

示例身份需替换为真实值。commandId、sessionId、leaseId 为 1–128 位字母、数字、`-`、`_`。fence 必须大于 0。sessionId 不复用，续期沿用已有 leaseId / fence；若控制面重新分配执行，使用新的会话。

| command.type    | 内容和行为                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------- |
| session.open    | leaseRequestId、leaseTtlMs、maxDurationMs；容量不足立即 NODE_BUSY，不在节点建全局队列         |
| session.renew   | leaseRequestId、leaseTtlMs；独立于浏览器操作续期                                              |
| session.close   | 撤销操作许可并等待关闭确认；当前节点身份可清理自己的已过期租约                                |
| browser.observe | 可选 screenshot；返回 observationId、url、title、text、targets、atomic，以及可选 artifactRefs |
| browser.act     | action 为 navigate / click / fill / press / scroll；写操作需开发配置显式启用                  |
| browser.wait    | selector + text；递归遍历 document 和 open Shadow roots，等待匹配元素包含文本                 |

导航的 target 是 HTTP(S) URL。点击/填写的 target 取自最近观察的 targets[].target（如 element-1），同时携带 observationId；填写使用 value，可以为空串。按键使用 value（如 Enter）；滚动 value 为 up/down/left/right，每次 400px。首版不支持原始 CLI ref、任意 shell、远端 JavaScript 或 CLI 参数透传。

观察的 targets 包含 target、role、name 及可选原生 tag、value、options。新观察或动作使旧引用失效；节点被替换时拒绝，不按同名元素重找。原生 DOM 和条件等待覆盖 open/closed Shadow DOM、同源及跨域 iframe。观察还包含 tabs、truncated 和可选 viewport；新增动作及边界见 [浏览器能力](browser-capabilities-ha.md)。

`browser.trace` 的 action 为 start / stop，由执行器管理。stop 返回 TRACE artifactRefs，通过证据通道可靠上传 JSON，单文件最多 64 MiB；只有 AVAILABLE 后才能报告引用。

命令期限从 Node 收到该命令起计算，包括排队和持久化消耗。超时后已经发生的网页效果不能撤销。关闭确认和结果落盘可以晚于操作期限；不能为了及时响应而提前释放容量。

## 结果与重送

command.result 携带原命令身份、messageId、operationStatus、effect，以及 data 或 error。

- operationStatus：SUCCEEDED、FAILED、TIMED_OUT、CANCELLED 或 UNKNOWN。
- effect：NOT_STARTED、COMPLETED 或 MAY_HAVE_HAPPENED。
- 超时/取消之后的网页写入可能已经发生，必须同时读取 effect；不能只根据状态自动重试。

Node 在派发前记录 commandId 与规范化 payload hash。相同请求重复送达返回已提交结果或 command.pending，不会另发一次浏览器动作；同 ID 不同 payload 返回 COMMAND_CONFLICT。节点身份校验优先，过期 nodeEpoch 不能用旧 commandId 绕过鉴权。

终态结果、session.closed 与 artifact.available 存入 SQLite outbox。控制面**持久化消息之后**发送 `{"type":"ack","messageId":"..."}`；断线期间操作按租约继续，重连后重送未 ACK 的结果。控制面必须按 messageId 去重，并核对租约归属，不能让旧 epoch 的恢复消息推进新执行。

重启时先关闭旧会话，再将未提交结果置为 UNKNOWN/MAY_HAVE_HAPPENED。只重送结果，绝不从数据库恢复业务动作。session.closed 的 closureVerified=true 才能代表已核实资源回收；QUARANTINED 保留容量。

无效 JSON Schema 返回 protocol.error；身份不符等前置拒绝不建立可重送记录。控制面不应把协议错误当成产品验收失败。

## 截图交付

观察结果中的 artifactRefs 初始为 PENDING，包含 artifactId、kind=SCREENSHOT 和 sha256。文件写入本地 spool 并 fsync 后登记 SQLite；每文件最多 8 MiB，spool 默认 256 MiB。

配置 artifact_upload_url 后，节点使用同一凭据向 `<地址>/<artifactId>` PUT PNG，附 Content-Length、Content-Type 和 X-Content-Sha256。上传地址必须与网关同 host / port，生产使用 HTTPS；不跟随重定向。

存储服务必须以 artifactId 幂等写入、校验 hash，持久保存后返回：

```json
{ "artifactId": "对应身份", "sha256": "对应内容摘要", "stored": true }
```

只有验证该回执并提交 SQLite 后，节点才发送 artifact.available 并删除本地文件。每 10 秒尝试待上传文件，网络失败不改成 AVAILABLE。控制面将 artifactId 关联回原命令与会话，验证最终报告引用。apps/api 已实现上传和可用确认入口；注册、worker 调用和持久化顺序见 [API 说明](../apps/api/README.md)。
