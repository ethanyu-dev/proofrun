# MCP 与 HITL 通知接入

ProofRun 在现有 API 上提供无状态 Streamable HTTP `/mcp`，使用固定版本 `@modelcontextprotocol/sdk`，复用同一个调度器和 PostgreSQL。cc-connect 暂未接入，端到端测试使用持久化收件箱模拟服务，不发送飞书消息。

## 配置

将 `PROOFRUN_INTEGRATIONS_FILE` 指向受部署系统管理的 JSON 文件。未配置时，MCP、集成提交和通知回读入口不注册。配置中的路径相对该 JSON 文件解析；每份令牌不少于 32 字符，各方向及 ADMIN/WORKER 之间不得复用。生产服务使用 HTTPS；HTTP 仅用于可信本机调试。

```json
{
  "connections": [
    {
      "id": "proofrun-staging",
      "url": "https://cc-connect.example.com",
      "deliveryTokenFile": "secrets/notification-delivery",
      "viewTokenFile": "secrets/notification-view",
      "bindings": [{ "ref": "triage-proofrun-qa", "version": 1 }]
    }
  ],
  "clients": [
    {
      "id": "dev-agent",
      "tokenFile": "secrets/dev-agent-mcp",
      "integrationId": "proofrun-staging",
      "bindingRefs": ["triage-proofrun-qa"],
      "defaultBindingRef": "triage-proofrun-qa"
    }
  ]
}
```

内存配置也接受 `token`、`deliveryToken`、`viewToken`；部署优先使用文件。同一令牌不能同时指定字面值与文件。配置在启动时加载，改变文件后重启。`id` 是持久归属，轮换凭据时保留它。cc-connect 管理 `bindingRef + version` 对应的机器人和群，ProofRun 不配置飞书密钥或 `chatId`。保留旧连接与绑定版本，直到它们关联的 case 结束；不要把同一版本改指向其他群。

MCP 客户端连接 `<ProofRun origin>/mcp`，每个请求携带 `Authorization: Bearer <客户端令牌>`，按 SDK 使用 `Accept: application/json, text/event-stream`。这是受控服务之间的静态身份认证，不提供 OAuth 发现。GET/DELETE 返回 405；工具提交后立即返回，由 `case_get` 查询，不维持 MCP 长任务。浏览器 Origin 只接受配置的 API 或 Console origin。

## 工具与 HTTP 入口

工具完整的输入、输出 Schema 以 `contracts/schemas/mcp-tools.json` 为准，业务对象复用 Case v2。工具包括：

- `proofrun_capabilities_get`：版本、允许绑定及远端当前就绪快照、能力限制。
- `proofrun_case_validate`：只编译业务计划、预算、分组、证据种类，不创建任务或身份租约。
- `proofrun_case_submit`：`{ case, source?, notification? }`，单 case 幂等接收。
- `proofrun_case_get`：`{ caseId }`，返回 `{ result: CaseResultV2, interventions, notificationDeliveries }`，保留双跑结果，不返回 HITL URL。
- `proofrun_case_cancel`：取消整例所有组。
- `proofrun_case_rerun`：`{ caseId, newCaseId, budgetMode? }`，沿用冻结环境与通知绑定；重跑需要新身份。
- `proofrun_evidence_read`：`{ caseId, artifactId }`，只读所属 case 已交付证据；校验 SHA-256，限制 8 MiB，截图返回 MCP image。

错误返回 `isError: true` 和 `{ code, message, retryable, effect, caseId? }`，输出 Schema 同时声明成功与错误结构，兼容会校验错误 `structuredContent` 的客户端。`FAILED` 是业务结果，不是工具错误。修改类工具发生未知错误或连接断开时，先查询同一 caseId，不能生成新身份盲目重交。

`POST /v1/integrations/cases` 与 MCP submit 共用服务和客户端令牌，返回 202。`GET /v1/integrations/notifications/{eventId}/view` 仅接受所属连接的 viewToken，禁止缓存。HTTP 契约同时发布到 `/docs/`。原管理 API 权限与行为保持兼容。

每个新 case 先向固定通知服务核验绑定。已接收 case 先读取冻结上下文，重提不会访问远端，也不会重新采用今天的默认绑定；定义、来源或显式事件集变化会冲突。管理入口创建的 case 不能被集成客户端接管。所有 case 读取、取消、重跑和证据读取均验证客户端归属。

## cc-connect 待实现的三个端点

请求使用 connection 的 deliveryToken；不跟随重定向，单次超时 10 秒，响应最大 64 KiB。

1. `GET /integrations/v1/proofrun/bindings/{bindingRef}?version=1`：返回 `{ integrationId, bindingRef, bindingVersion, enabled, botReady }`，可附带受控展示字段。版本或服务身份不匹配、绑定关闭、机器人未就绪时拒绝新提交。能力查询报告当前就绪；启动不因 cc-connect 离线失败，以便恢复已有 case。
2. `POST /integrations/v1/proofrun/events`：按 `notification-event.schema.json` 接收不含处理链接的信封。先持久化，再返回 202 `{ eventId, receiptId, status: "accepted" }`；相同 eventId 相同内容返回原回执，不同内容返回 409。绑定关闭或权限不匹配应返回 403。必须用固定 ProofRun origin 和 viewToken 回读视图；不能信任事件指定任意回读地址。
3. `GET /integrations/v1/proofrun/deliveries/{eventId}`：按 `notification-receipt.schema.json` 返回 `accepted / retrying / delivered / unknown / failed / superseded`。202 不代表飞书已发送；`unknown` 表示发送结果不明，ProofRun 不重发新事件或宣称成功。

绑定回读、事件、视图和投递回执的字段是双方后续联调的约定。客户端令牌、deliveryToken、viewToken 三者独立；只有 viewToken 可以读取短期处理链接。飞书消息发送凭据全部留在 cc-connect。

## 持久化与状态

迁移 022 增加 case 调用者/绑定快照、稳定 `request_id`、通知聚合及 outbox。绑定与所有 case 执行组在调度事务中原子写入。HITL、执行、会话、任务的状态触发器延迟至提交前投影最终状态，与业务事务一起提交或回滚，覆盖人工交还、无法执行、取消、等待超时和租约终止。

每次人工请求有独立稳定身份，链接轮换只更新授权身份，不改变请求身份。`hitl.requested / updated / resolved / closed` 以聚合内递增序列保存；可选 `case.finished` 仅在全部执行组终止时产生一次。`resolved` 只表示恢复自动执行，不表示业务验收通过。回读旧事件仍得到最新聚合视图；不活动、过期或已终止授权不返回 action。GET 不会轮换链接；后台维护使用已有控制服务轮换仍在等待的过期链接。

通知投递后台循环独立于任务调度，最多四个并发请求，网络错误、408、429、5xx 使用相同 eventId 重试，基础退避 2 秒至 60 秒并附加抖动，遵守 Retry-After。持久接收后查询回执，不重复 POST。24 小时仍无法确认则记录 unknown；普通 4xx 记录 failed。移除连接配置会使待投递事件明确失败，不能静默改路由。`case_get.notificationDeliveries` 可见事件身份、状态、尝试次数与下一次查询时间；远端错误正文不持久化，避免写回敏感链接。

## 模拟验证

```sh
PROOFRUN_TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/postgres \
  pnpm test:mcp
```

测试创建独立临时数据库并清理，管理连接需要建库权限，不能指向需要保留的业务测试数据。模拟 cc-connect 在回环端口运行，使用真实 PostgreSQL 收件箱；浏览器节点与 worker 使用协议夹具。覆盖官方 MCP 客户端、归属隔离、幂等/并发提交、默认绑定冻结、重启补发、丢失确认、事务回滚、通知故障恢复、人工交还/无法执行/超时、链接轮换、旧链接失效、双跑终态、unknown 回执、证据归属/摘要/大小。

这些检查不证明真实飞书投递、真实 Chromium 操作或模型验收质量。下一阶段将模拟服务替换为 cc-connect 的三个实际端点，并验证机器人群权限与卡片更新；Console 通知状态组件仍可后续扩展，当前状态通过 MCP 查询。
