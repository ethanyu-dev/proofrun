# Browser Node 0.1 协议

这是首版实现的节点协议；不包含任务分析、验收标准或 LLM 配置。源文件为 `contracts/schemas/node-command.schema.json` 和 `node-event.schema.json`。TS 类型与 Rust 命令类型从相同源文件生成，两个入口都执行 Schema 校验；业务身份与期限另做校验。

## 连接与租约

Node 为每个获准绑定主动连接其 gateway_url，使用 `Authorization: Bearer <token>`。非 loopback 地址强制 WSS；另在回环地址监听客户端直连，由节点本机 HTTPS 代理提供入口。连接成功即发送 node.heartbeat，之后每 5 秒发送。网关须回应 ACK、Ping 或业务消息；30 秒没有收到任何消息则重连，退避 1–15 秒。

心跳包含 nodeId、每次启动变化的 nodeEpoch、pool、publicUrl、admission、occupied、能力声明、limits（maxLeaseMs / maxSessionMs）和 leaseRequestId。关闭中的会话与 QUARANTINED 会话仍计入占用。控制面拥有全局队列和节点注册表，心跳只是节点事实。

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

### Profile tab 路由

节点心跳能力 `profileTabs: true` 表示支持浏览器命令上的可选 `tabScope`。同一 session 的每个 scope 首次使用时创建 tab，后续每条命令先切回该 tab；观察、元素映射、frame 和视觉引用按 scope 隔离，观察只展示所属 tab。分组自动动作不能创建、切换或关闭其他 tab。没有 scope 的历史命令继续使用原会话行为，人工操作使用已定位的求助 tab。

控制面要求新任务命令携带对应 RUNNING 步骤的 `stepId`，并核对冻结计划中的 tabScope。模型调用也携带 stepId，动作和模型预算按步骤独立累计；整段 cleanup 共享自己的预算。报告证据通过已持久化命令核对分组归属。网络/TRACE 仍属于整个 profile，需要这类证据时 Agent 串行执行分组。

## 资源准入与客户端连接

`admission` 包含 accepting、reason、cpuPercent、availableBytes、reserveBytes；旧 capacity 字段仅为历史兼容，不参与调度。缺少准入声明的旧节点不能接收新任务。`publicUrl` 是节点上报的客户端 HTTPS origin，`capabilities.directHitl` 表示节点直连能力。创建时节点仍原子复核资源，`RESOURCE_UNAVAILABLE` 且 `NOT_STARTED` 的创建拒绝可以安全重排。

浏览器命令携带 actor、controlRevision 与 authRevision。`session.control` 切换 AUTO/HUMAN 或安装短期人工能力，`session.watch` 安装只读画面能力。能力绑定会话信封身份、精确 Origin、有效期和令牌摘要；不会返回节点凭据。

直连输入沿用 commandId 去重，但生成 `hitl.result` 可靠事件而非假冒 API 命令结果。事件只带操作类型/动作摘要和认证版本，不带输入值。`hitl.finished` 保存完整待办确认或无法处理原因。它们与其他节点事件一样等待 API inbox 提交后的 ACK，断线重送不会重复业务操作。

## 多控制面连接范围

每个绑定以独立 nodeId 和 Bearer 凭据连接所属 API；Node 在已认证连接上下文确定归属，不接受消息选择其他绑定。`pool` 和 `occupied` 是绑定内视图，`admission` 来自整台节点的资源裁决。命令、租约、ACK 和事件去重均按绑定隔离，外部相同 ID 不冲突。

HITL / Live bootstrap 返回绑定的 `nodeId`。客户端首条 `authenticate` 带 `nodeId`、`id`、`token`，Node 只在该绑定内查找授权，再核对 Origin、短期令牌、代次及租约。显式绑定必须携带 nodeId；省略字段仅兼容尚未导入的旧单控制面入口。控制面安装的 grant.origin 必须在节点拥有者批准的来源列表中。原有命令信封和 API 数据库不新增 bindingId 字段，归属由独立连接及 nodeId 固定。
