# proofrun-api

ProofRun 的最小控制面：接收上层已定义的任务，持久化全局队列和节点容量，通过内网节点主动建立的 WebSocket 下发操作，保存执行事实、证据与最终报告。没有 Spec Runtime，也不运行模型。

上层调用方只需 [Case API](../../docs/public-api.md)，或导入 [OpenAPI](../../contracts/public-api.openapi.json)。平台维护者先设置 [case 执行配置](../../docs/case-platform-config.md)。下文的任务、worker、节点运维和 Console 接口属于内部协议。

## 共享执行运行时（版本 1）

新入队任务默认冻结 `runtime_version=1`、`executor_kind=builtin`。API 持有共享执行器、账本、观察/动作、分组门禁和报告组装；内置 Worker 持有模型供应商配置，只续租、领取模型上下文、保存模型审计并提交一次决定。API 不读取模型密钥。共享模块见 [execution-core](../../packages/execution-core/README.md) 和 [execution-driver](../../packages/execution-driver/README.md)。

内部接口使用单次 execution lease token，不能使用公共 MCP principal：

| 接口                                                    | 请求与响应                                                                                                                                                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/executions/:id/runtime`                       | `{type:"start",config:{model,vision,commandMs,evidenceMs,maxTurns,maxContextChars}}`；冻结非秘密配置，重复相同请求不启动第二个驱动                                                                                 |
| `GET /v1/executions/:id/runtime?afterRevision=0`        | `state:ACTIVE/FINISHED/LOST`、最多一帧 `decisions`、最终 `report`；GET 不续租                                                                                                                                      |
| `POST /v1/executions/:id/runtime/decisions/:decisionId` | `{type:"trace_start",revision,request}` → `{type:"trace_finish",revision,result}` → `{type:"decision",revision,outcome:{output\|error}}`；严格字段见 [Schema](../../contracts/schemas/runtime-request.schema.json) |

决定帧包含 `id/revision/text/modelDeadlineAt/imageArtifact?`。text 为既有七模块上下文；图片按引用读取，不把 base64 存入帧。模型请求存档完成前不能派发，回复存档完成前不能提交决定。每帧的阶段摘要、控制/认证代次和最终决定均持久化；相同消息重送复用结果，异体重送返回 `IDEMPOTENCY_CONFLICT`，旧版本返回 `REVISION_CONFLICT`，控制权变化返回 `CONTROL_CHANGED`。合法 progress 在下一动作前保存。操作意图先落库，实际命令仍由原 `pr_commands` outbox、预算准入与节点幂等处理。

版本 1 禁止通过旧 worker 的 commands、steps、complete、intervene、control、model-calls 写入接口绕过共享层；管理员介入、节点协议和真正的 Worker 心跳保持原入口。API 自身不会替失联 Worker 续租。正常完成与续租撤权竞争时，Worker 只短暂读取最终报告。API 重启会保留已知回执和部分结果，以 `EXECUTION_RUNTIME_LOST` 关闭遗留版本 1 运行，不重放业务步骤。

分批升级先部署新 API 并设 `PROOFRUN_EXECUTION_RUNTIME_VERSION=0`，再部署支持 `runtimeVersion:1` 的 Worker，最后切换为 `1`（部署默认值）。新 Worker 的领取字段需要新版 API，不能先连到未升级的严格校验入口。配置仅影响之后新建运行；原有记录保持版本 0，新 Worker 仍兼容旧路径，旧 Worker 不能领取版本 1。迁移是增量 SQL；回退新入队策略不删除审计数据。程序化 `buildApp` 未指定版本时沿用版本 0，以保持既有嵌入式调用和测试行为。外部执行固定使用版本 1，由外部 controller supervisor 续租；直接操作见下文。操作级 MCP 工具已注册，复用同一外部执行服务。

运行 `PROOFRUN_TEST_DATABASE_URL=... pnpm test:agent:integration` 检查真实 API/数据库/HTTP 模型适配闭环；模型结论和 WebSocket 节点来自夹具，不代表生产站点验收。

## 任务级 MCP 与 v3 API

第一阶段提供两个 Streamable HTTP MCP：`/mcp/browser` 委托浏览器任务，`/mcp/verification` 委托结构化 Case 验证。两者复用现有 Case 编译、请求归属、调度、取消、报告和证据服务；不启动另一套 worker，不在 API 内调用模型。默认 `executor.kind=builtin`；验证提交也支持 `external`，由外部 Agent 通过两套 MCP 的操作工具或下文 HTTP API 直接执行。两套目录各有 16 个工具，发现结果按凭据 scope 过滤。

默认关闭。API 启动前设置 `PROOFRUN_MCP_CREDENTIALS_FILE`，指向权限 `0600` 的普通 JSON 文件，最多 100 条记录。每个令牌独立随机生成至少 32 字节，客户端保存原令牌，服务端配置只保存其 SHA-256 小写十六进制摘要。以下占位值须替换为真实摘要：

```json
[
  {
    "principalId": "upstream-ci",
    "tokenSha256": "替换为64位小写SHA256摘要",
    "channels": ["browser", "verification"],
    "scopes": [
      "browser:delegate",
      "verification:submit",
      "runs:read",
      "evidence:read",
      "runs:cancel"
    ]
  }
]
```

凭据文件不进入仓库。配置变更/轮换需要重启 API；同一 `principalId` 可配置不同令牌与不同 scopes，资源归属保持稳定。管理员/worker 令牌不会自动获得 MCP 权限，公共令牌也不能访问管理员入口。旧 API 创建的资源不会自动认领。不同 principal 的读取统一返回 404，已绑定资源的身份冲突返回 409，自己的已删除资源返回 410。

权限同时约束 `tools/list` 和实际调用：`browser:delegate` 允许浏览器提交；`verification:submit` 允许预检、提交、重跑；`runs:read` 允许请求/运行/操作读取；`evidence:read` 允许证据工具、资源和下载；`runs:cancel` 允许取消。能力发现需有效凭据；写入还检查资源归属。生产入口使用 HTTPS，代理保留公开 Host；带 Origin 的请求仅接受配置的 API/Console origin。

| Browser 工具               | 参数                                                                            | 行为                                                   |
| -------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `browser_get_capabilities` | `url?`, `runId?`                                                                | 返回实现、配置限制及未检查项，不探测目标 URL           |
| `browser_task_submit`      | `taskKey`, `url`, `objective`                                                   | 复用浏览器任务服务；第一阶段拒绝 session/预算/节点覆盖 |
| `browser_task_get`         | `runId`, `view?:summary\|full`, `cursor?`, `limit?`                             | 读取明确运行；browserResult 与验证 PASSED 分开         |
| `browser_task_cancel`      | `runId`, `operationId`, `reason?`                                               | 取消指定运行；不表示物理关闭已完成                     |
| `browser_evidence_read`    | `runId`, `evidenceId`, `representation?:metadata\|content`, `offset?`, `limit?` | 默认元数据，按归属读取已交付证据                       |
| `browser_operation_get`    | `operationId`                                                                   | 找回已提交的取消操作回执                               |

| Verification 工具               | 参数                                                                                                                                                                                         | 行为                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `verification_get_capabilities` | `entry?`, `executor?`                                                                                                                                                                        | 返回 Case 约束、证据及身份支持；实时资源未探测时明确 unknown |
| `verification_validate_cases`   | `requestId`, `title?`, `cases`, `executor?`                                                                                                                                                  | 只读预检；返回字段错误、分组、逐步预算和取证需求             |
| `verification_submit_cases`     | 与预检相同                                                                                                                                                                                   | 整批原子提交；回执逐项区分 created/reused                    |
| `verification_get_request`      | `requestId`, `view?:summary\|report`, `cursor?`, `limit?`                                                                                                                                    | 当前成员、绑定版本与汇总/逐项结果                            |
| `verification_get_run`          | `runId`, `view?:summary\|full`, `cursor?`, `limit?`                                                                                                                                          | 历史运行也可读取，不切换到 Case 最新运行                     |
| `verification_cancel_run`       | `runId`, `operationId`, `reason?`                                                                                                                                                            | 精确取消；列出本调用方的受影响请求，超过 100 条显式标记截断  |
| `verification_rerun_cases`      | `requestId`, `operationId`, `expectedRequestRevision`, `items:[{caseId,sourceRunId,runKey}]`, `executor?`, `budgetMode?:current\|original`, `timeBudget?:{stepTimeoutMs?,cleanupTimeoutMs?}` | 原子创建新运行并替换所选请求成员；拒绝过期来源/版本          |
| `verification_read_evidence`    | 同浏览器证据工具                                                                                                                                                                             | 单独安装验证 MCP 也能取证                                    |
| `verification_operation_get`    | `operationId`                                                                                                                                                                                | 找回取消/重跑回执                                            |

`requestId/taskKey/caseId/runKey` 使用 1–80 位字母数字、下划线或短横线；`runId` 上限 160。`operationId` 为 UUID。每批 1–32 个 Case，总请求上限 2MiB，Case 使用现有 v2 Schema。默认 executor 为 builtin；验证预检/提交允许 external，并要求 verification:control。任务级浏览器委托和重跑仍只支持 builtin；未知字段会拒绝。`objective` 为 1–20000 字符非空文本，URL 只接受 HTTP(S)。详细输入/输出由 [共享 Schema](../../contracts/schemas/mcp-task-call.schema.json) 生成；MCP 每个工具有独立、自包含的 inputSchema/outputSchema。错误输出包含 `code/message/retryable`，并设置 `isError`；业务失败仍是正常结果数据。

提交使用稳定 taskKey/requestId，重试返回首次冻结的回执；同键不同输入返回 `IDEMPOTENCY_CONFLICT`。Case 可被同一 principal 的多个请求复用，reused 不表示重新验证。builtin 新验证通过重跑：先读取请求返回的 `requestRevision`（当前成员绑定的 SHA-256，不是递增整数），再携带准确的 sourceRunId、新 runKey 和稳定 operationId。回执查询、重试不会重新执行操作；来源版本冲突需刷新后重新决策。回执、归属、入队/取消/成员替换共用一个数据库事务，断线不自动取消，软删除不释放旧幂等键。

摘要默认不含验收详情；full/report 的 `criteriaPage` 默认 25 条、最多 100 条，并受 96KiB 条目预算限制。`nextCursor` 绑定资源、视图与报告版本；收到 `CURSOR_STALE` 从第一页重读。`textTruncated` 表示摘要截短。任务状态、reportPhase、reportStatus、cleanup、closureVerified 分别读取，终态不能直接推断验收通过或会话已关闭。

证据必须同时满足本 principal 的 run 归属、结果已引用、数据库 AVAILABLE，且 artifact 对应同一次运行；不能仅凭 artifactId 下载。DOM/NETWORK/RUNTIME 文本以 UTF-8 解码后的 JavaScript 字符串偏移分页，默认 20000、最大 100000；`sha256` 始终校验原始附件字节。截图最大 8MiB，MCP 返回原生 image；TRACE 返回元数据与受保护下载地址。单次文本载入上限 2MiB，超限走下载。资源 `proofrun://runs/{runId}/evidence/{evidenceId}` 使用相同权限；`proofrun://guides/tasks` 提供调用说明，验证端另提供 `proofrun://schemas/case-v2`。页面与证据正文不是平台指令。

HTTP 客户端也可使用同源 `/v3` 接口：

| HTTP                                                                        | 对应工具                    |
| --------------------------------------------------------------------------- | --------------------------- |
| `GET /v3/browser/capabilities`、`POST /v3/browser/tasks`                    | browser capabilities/submit |
| `GET /v3/verification/capabilities`                                         | verification capabilities   |
| `POST /v3/verification/requests/validate`、`POST /v3/verification/requests` | validate/submit             |
| `GET /v3/verification/requests/:requestId`                                  | get_request                 |
| `POST /v3/verification/requests/:requestId/reruns`                          | rerun_cases                 |
| `GET /v3/runs/:runId`、`POST /v3/runs/:runId/cancel`                        | 按任务类型选择 get/cancel   |
| `GET /v3/operations/:operationId`                                           | operation_get               |
| `GET /v3/runs/:runId/evidence/:evidenceId`、追加 `/download`                | 证据读取/原始附件下载       |

HTTP 返回同样的 `{kind,data}`；提交/重跑返回 202，仅代表已入队。路径身份从正文中省略，其余字段与 MCP 相同；能力查询 executor 可选 builtin 或 external，查询分页参数转换为整数。证据下载携带同一 Bearer，不是公开 URL。完整字段见 `/openapi.json` 或 `/docs/` 中的 Task API v3。两个 MCP 未配置时这些 v3 路由也不注册。

实现拆分为 `modules/mcp`（协议、工具目录、独立提示词）与 `modules/public-execution`（权限、事务回执、有界投影、证据和领域适配）。迁移 `039-public-task-access.sql` 仅增加归属与回执表，不复制执行事实。后续共享执行层可以替换领域适配内部实现，无需改动客户端任务协议。

测试入口为 `test/task-mcp.test.ts` 与 `tests/contracts/task-mcp.test.mjs`。前者使用真实 MCP SDK、HTTP、临时 PostgreSQL 数据库，覆盖权限、并发/幂等、事务故障回滚、重启恢复、重跑版本、精确取消、部分报告、游标和证据。报告与附件为夹具，不代替真实节点/模型端到端验收。

## 运行边界

一个 Fastify 进程、一个 PostgreSQL 数据库、一块持久证据磁盘。当前不引入 Redis、独立调度服务或通用工作流引擎。数据库实例锁保证同一数据库只有一个活动 API；多台 Browser Node 和多个 worker 可并发接入。

- API 拥有全局任务、队列、容量预留、worker 租约和报告。
- Rust Node 拥有本机执行、会话租约、进程关闭确认和本地恢复。
- worker 使用受限 HTTP 浏览器操作；不能指定节点会话、fence，不能直接签发租约。
- 数据库写入先于命令发送，事件持久化先于 ACK。断线只重送原命令，不创建新的业务动作。
- 任务终态与会话清理分开记录。只有可信的关闭确认或创建前拒绝才能释放容量。

`/health/ready` 成功表示控制面数据库和实例所有权可用，`executionWorkerProtocol: true` 表示支持执行 Agent 接入，不表示 worker 或模型服务当前健康。

## 本机启动

需要 Node.js 24、pnpm 10.30.2、PostgreSQL 17。从仓库根目录运行：

```sh
# 分别生成并保存密钥；数据库密码需与 DATABASE_URL 一致。
export PROOFRUN_POSTGRES_PASSWORD="$(openssl rand -hex 24)"
export PROOFRUN_DATABASE_URL="postgresql://proofrun:${PROOFRUN_POSTGRES_PASSWORD}@127.0.0.1:5432/proofrun"
export PROOFRUN_ADMIN_TOKEN="$(openssl rand -hex 32)"
export PROOFRUN_WORKER_TOKEN="$(openssl rand -hex 32)"
export PROOFRUN_PUBLIC_URL=http://127.0.0.1:4100
export PROOFRUN_ARTIFACT_DIRECTORY="$PWD/.proofrun/api-artifacts"
docker compose -f deploy/postgres.compose.yml up -d --wait
pnpm dev:api
```

启动时按版本事务执行 `migrations/` 中的 SQL 迁移。这是新库协议，不迁移旧项目数据。配置说明在根目录 `.env.example`；应用不会自动加载 `.env`。

远端使用同一个 HTTPS/WSS origin，由反向代理转发 HTTP 和 WebSocket Upgrade。API 自身默认仅监听回环地址。节点向外连接，控制面不需要访问业务内网。数据库与证据目录都必须持久化。

## 验证看板统计

管理员接口 `GET /v1/admin/statistics?period=week&date=2026-10-21` 返回自然周期汇总 `summary` 和补齐空白日期的 `days`。`period` 支持 `day`、`week`、`month`，默认 `week`；`date` 为周期内任意有效日期，默认北京时间今天，不接受未来日期。响应还包含 `startDate`、`endDate`、`timeZone` 和同一只读事务的 `generatedAt`，使用管理员鉴权及 `Cache-Control: no-store`。

统计以北京时间自然日为边界，周一开始。Case 按可见请求成员与请求创建日归属，展示请求当前关联的单 LLM 运行；同一运行可被多个请求复用。`runs` 按每次运行提交日单独计数，普通任务按一个 Case 计数，独立清理排除。结果使用与现有报告一致的业务判定；`passRate` 是 `passed / finished` 的 0～1 比例，无已结束 Case 时为 `null`，周期值按分子分母总数重新计算。

Tokens 查询验证执行调用，按服务端开始记录时间累计，不连接请求成员，避免复用放大。`unmeasuredCalls` 标记输入或输出缺失的调用，合计仅包含已知部分；无调用与未上报通过 `calls` 区分。没有逐次调用的历史报告可按任务结束日回填汇总，`legacyUsageTasks` 返回回填数量；两类记录同时存在时只计调用。归档保留的模型用量继续参与统计。

启动自动执行 `029-dashboard-statistics.sql`，增加调用时间和旧报告结束时间索引；无额外 Worker、聚合任务或模型调用。控制台须与 API 同步更新。统计和 UI 回归分别在 `apps/api/test/dashboard.test.ts` 与 `tests/console/dashboard.test.ts`，不代表供应商账单核验或生产规模性能验收。

## Case 飞书生命周期通知

在飞书开放平台创建企业自建应用，开启机器人能力，申请 `im:message:send_as_bot` 权限并发布应用，再把应用机器人加入目标群。使用同一应用身份[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)和[更新卡片](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch)，不需要配置事件订阅或卡片回调地址。

在 API 服务端配置以下环境变量并重启：

```sh
export PROOFRUN_FEISHU_APP_ID='cli_替换为应用ID'
export PROOFRUN_FEISHU_APP_SECRET='替换为应用密钥'
export PROOFRUN_FEISHU_CHAT_ID='oc_替换为目标群ID'
export PROOFRUN_CONSOLE_URL='https://你的控制台域名'
```

`PROOFRUN_FEISHU_CHAT_ID` 填目标群完整的 `oc_...` 字符串。获取与配置步骤：

1. 先在目标群的「··· → 设置 → 群机器人 → 添加机器人」中加入上述自建应用机器人。
2. 飞书客户端升级到 **7.60 或以上**，打开目标群右上角菜单，进入群设置页查看并复制群 ID。入口说明见飞书官方[群 ID 说明](https://open.feishu.cn/document/server-docs/group/chat/chat-id-description)。
3. 若客户端没有显示，可登录 [API 调试台](https://open.feishu.cn/api-explorer)，选择需要 `chat_id` 路径参数的接口，在「路径参数 → 选择群组」中找到目标群并点击「复制群组 ID」。这里只需要复制 ID，无需调用修改群信息的接口。
4. 把完整 ID 配到 API 服务环境变量，例如 `PROOFRUN_FEISHU_CHAT_ID=oc_实际群ID`，与同一机器人的 App ID、App Secret 一起保存并重启 API。Railway 在 `api` 服务 Variables 中填写变量值，不带 `export` 或额外引号；本地则写入 `.proofrun/local.env`。

群 ID 不是群名称、分享链接、Webhook 地址或应用 ID。查到群 ID 不等于机器人已加入群；若无法推送，先核对机器人群成员身份、应用已发布且拥有 `im:message:send_as_bot` 权限。无需为通知配置消息读取权限。

三个飞书变量同时填写或全部留空；全部留空时关闭通知，部分配置会阻止 API 启动。应用密钥仅在服务端用于交换并缓存 `tenant_access_token`，不放入 `VITE_*`、任务定义、消息进度表或版本库。Console 地址需为群成员可访问的 origin；未配置时使用 `PROOFRUN_PUBLIC_URL`。

使用 `pnpm dev:local` 时，将三个变量写入 `.proofrun/local.env`，启动器仅传给 API；本机默认生成回环 Console 链接，群内其他设备使用前应改用具有可访问 Console 地址的部署。Railway 则仅在 `api` 服务变量中配置。

v2 请求按 `requestId` 聚合通知，标题统一为「自动化测试 · 当前状态」，卡片不再展示执行模式或对照组信息：

- 请求提交：发送一张主卡片，逐项展示 case 内容、验证状态与本次请求提交时间。case 开始、恢复、完成等变化只更新原卡片。
- 进入 HITL：每个 case 首次需要人工处理时发送一张专属卡片，上半部仅保留 case 内容与首次介入时间，下半部保留当前状态、介入原因、待办、截止时间和专属处理入口；接管、恢复、后续多轮 HITL 和执行结束均更新同一张卡片，不重复发送。
- 全部 case 结束：另发一张汇总验证报告卡片，仅逐项展示 case 内容与最终结论，保留完整报告入口；标题显示最终验收状态。部分完成不发送报告卡片，结束也不等于验收通过。

请求内单 case 或整体重跑使用本次幂等摘要建立新的通知轮次，提交时间取重跑时间；原轮次停止投递与更新。新轮次读取请求当前成员，全部结束后才发送汇总，同一重跑重试或服务重启不重复发卡。替换前会在同一事务中保留旧成员的通知归属，避免旧任务脱离当前关联后被重新当作独立 Case 补发。

没有请求归属的独立任务保留提交及完成通知，HITL 同样复用 case 卡片。历史比较任务仍等待所有成员结束，但不展示组别。卡片显示北京时间；有效 HITL 提供「立即处理」，结束、过期或会话失效后移除操作入口，后续新一轮 HITL 更新为新入口。报告生成后 case 卡片的「查看任务」切换为「查看报告」。处理链接仅供本群协作人员使用；任务及报告页面仍需要 Console 管理员认证。主卡片及汇总报告移除请求摘要和分割线。大请求只展开前十个 case，完整内容可在 Console 查看。

首次启用只通知启用后提交的请求或独立 Case，不补发历史任务；新请求复用历史 case 时仍按新请求通知，但不会重放已结束的旧 HITL。节点模板维护和独立清理任务不推送。同一应用和群的通知起点、卡片身份、发送回执及更新进度持久化；重启后同步期间变化，不为每次状态变化补发新消息。切换应用或群会建立独立通知起点，不能跨群更新旧卡片。

扫描与业务调度独立，每秒轮转一个请求或独立 Case，最多发送一张新卡片、更新三张旧卡片，更新为最终一致。单次 HTTP 最多五秒；失败按 10、20、40、80 秒退避，总计最多五次。某张旧卡片失败不影响其他卡片，当前状态发生变化时可重新尝试该卡片的新版本。日志只含内部通知 ID、次数及数值错误码。

迁移 `026` 会停止请求成员的旧独立通知轮次，并为仍在执行的请求复用可用的旧提交和 HITL 卡片。已有旧通知且全部结束的历史请求不会因升级重发；未选中的旧卡片记录仍保留供审计。

首次发送前冻结内容与 UUID，回执丢失时复用它们重试。飞书发送去重窗口为一小时，本实现首次尝试超过 55 分钟后停止未知结果重发；不能承诺无限期严格一次送达。旧卡片只可更新发送后十四天内的消息，已删除或撤回的消息也会停止更新。达到重试上限会留存记录并告警；修复故障后，维护者可按 `pr_feishu_messages.id` 精确重置对应发送或更新的次数及下次时间，并清空其 `pr_feishu_runs.settled_at`，但不要重置首次发送时间以绕过去重窗口。

从旧 webhook 方案升级时移除 `PROOFRUN_FEISHU_WEBHOOK_URL` 和 `PROOFRUN_FEISHU_SIGNING_SECRET`，改配上述应用变量。只配置旧变量时 API 会提示迁移。迁移 `023` 的旧投递记录保留，`024` 增加应用消息进度表；自建应用无法接管旧 webhook 已发卡片。

`feishu.test.ts` 验证应用配置、令牌刷新、卡片结构、回环 HTTP 与错误脱敏；`feishu-lifecycle.test.ts` 在独立 PostgreSQL 验证迁移复用、请求聚合、case HITL 原位更新、完成报告、重启恢复、独立重试和链接失效。它们不连接真实飞书群，不代表飞书客户端渲染、应用权限或生产网络已验收。

## 节点配对

1. 管理员调用 `POST /v1/node-pairings`，提交 `{"type":"node.enroll","pool":"internal","name":"vm-01"}`，取得十分钟有效的一次性 `pairingToken`。
2. 在远端设置 `node.toml` 的 `pool`、`gateway_url` 与同源 `artifact_upload_url`。将配对码放入仅节点用户可读的文件。
3. 运行 `proofrun-node --config /etc/proofrun/node.toml pair --pairing-token-file /private/path/pairing-token`。节点写入安装身份和 0600 凭据文件，标准输出不包含机器密钥；成功后删除配对码文件。
4. 运行 `serve`。`GET /v1/nodes` 可查看注册信息、在线状态、能力和节点占用清单。

节点凭据只允许自己的连接和截图上传。撤销接口为 `POST /v1/nodes/:id/revoke`；撤销会结束相关执行，但不会凭空确认浏览器已经关闭。已支持空闲节点凭据轮换和原配对码在有效期内取回同一回执，具体见 [部署与运行维护](../../deploy/README.md)。

## 按域名分发到执行节点

Console → 执行节点 → 对应节点卡片的「配置域名」，每行填写一个完整域名或 `*.example.com` 通配符规则。配置保存在 API 的 PostgreSQL，由 API 调度器在 worker 领取时读取，VM 无需额外配置。

- 匹配范围为任务的 `environment.nodePool`，按初始 `target.url` 的主机名匹配。同一池内相同规则只能绑定一个节点，不同池可重复配置；精确域名和不同范围的通配规则可以绑定不同节点。
- 忽略大小写、URL 端口及域名末尾的根域点，中文域名统一为 ASCII。配置不接受协议、端口或路径；普通域名只精确匹配，`example.com` 不匹配 `sub.example.com`。
- 只支持最左侧的 `*.`：`*.example.com` 匹配 `a.example.com` 和 `a.b.example.com`，不匹配 `example.com` 或 `badexample.com`；需要匹配根域时单独添加。通配符不能用于 IP 地址。
- 精确规则优先于通配规则；多个通配规则命中时，后缀最长（范围最具体）的规则优先。选定节点不可用时不会回退到更宽泛的规则。
- 命中后只分配到指定节点，仍检查容量、能力、凭据状态和 `environment.auth.nodeId`。节点离线、满载、撤销或显式登录节点冲突时继续排队，达到原任务截止时间后超时；不会绕过命中的路由。不再使用自动登录槽偏好。身份来源只准备当前临时会话。
- 未命中规则时沿用原资源池调度。规则不是访问白名单，也不根据后续跳转或页面子资源重新调度。
- 修改影响尚未分配的任务；运行中的会话保留原节点。清空列表并保存解除绑定。撤销节点保留原规则，可在已撤销节点卡片中清空后重新绑定。

管理员接口 `POST /v1/nodes/:id/routing` 完整替换该节点的域名列表：

```json
{ "domains": ["internal.example", "*.internal.example"], "revision": 0 }
```

先从 `GET /v1/nodes` 读取 `routing_domains` 和 `routing_revision`，写入时携带该版本。响应返回归一化的 `domains` 和新 `revision`。重复绑定返回 `409 DOMAIN_ASSIGNED`，过期编辑返回 `409 ROUTING_CHANGED`，均不会部分写入。每节点最多 100 个域名。迁移 `007-node-routing.sql` 在 API 启动时自动执行，既有节点默认无绑定。

验证：`pnpm test:api` 覆盖接口权限、配置归一化、原子冲突、并发配置、固定节点、容量限制、离线/撤销/登录冲突、未命中回退及重启持久化；使用真实 PostgreSQL 和模拟节点，不代替真实 Linux VM 的网络或浏览器验收。

## 执行协议

除上述节点域名配置使用 [NodeRoutingWrite](../../contracts/schemas/node-routing-write.schema.json) 外，HTTP 写入结构以 [ControlRequest](../../contracts/schemas/control-request.schema.json) 为准；任务与报告分别复用 `VerificationTask` / `VerificationReport`。

| 调用                                           | 凭据     | 行为                                                 |
| ---------------------------------------------- | -------- | ---------------------------------------------------- |
| `POST /v1/tasks`                               | Admin    | 提交不可变任务，返回 202；同 ID 同定义幂等           |
| `GET /v1/tasks/:id`                            | Admin    | 原定义、状态、报告、错误和会话清理进度               |
| `POST /v1/tasks/:id/cancel`                    | Admin    | 撤销执行权限并发起清理                               |
| `POST /v1/worker/claim`                        | Worker   | `worker.claim`；无可执行任务时返回 `execution: null` |
| `GET /v1/executions/:id`                       | 执行令牌 | 就绪状态、租约和证据清单                             |
| `POST /v1/executions/:id/heartbeat`            | 执行令牌 | 续期 worker 权限，不修改任务硬期限                   |
| `POST /v1/executions/:id/commands`             | 执行令牌 | `execution.command`；返回 202 和当前缓存结果         |
| `GET /v1/executions/:id/commands/:commandId`   | 执行令牌 | 查询结果，不产生额外派发                             |
| `POST /v1/executions/:id/complete`             | 执行令牌 | `execution.complete`；校验并存档报告，开始关闭       |
| `GET /v1/artifacts/:id`                        | Admin    | 下载已存储 DOM 或 PNG                                |
| `GET /v1/executions/:id/artifacts/:artifactId` | 执行令牌 | 读取本次执行证据供模型判断，跨执行返回 404           |

领取响应中的 `execution` 包含 `id`、原始 `task`、`leaseToken`、`leaseExpiresAt`、`taskDeadlineAt`、`sessionId`、`nodeId` 和初始 `state=STARTING`。worker 从领取开始周期续租，等待 `state=RUNNING`，然后观察或操作浏览器。默认 worker 租约 15 秒，建议每 5 秒续期；浏览器长操作期间也必须续期。节点租约不超过 worker 剩余授权、任务期限与节点上限。

浏览器操作示例：

```json
{
  "type": "execution.command",
  "commandId": "a-persistent-client-generated-id",
  "timeoutMs": 15000,
  "command": { "type": "browser.observe", "screenshot": true }
}
```

同一会话仅允许一个未完成浏览器操作。HTTP 响应丢失时，以相同 ID 和内容重提；相同 ID 改内容返回 409。租约结束后可查询历史结果，或重提已有命令取得缓存，但不能提交新动作。`MAY_HAVE_HAPPENED` 会终止本次执行；平台不自动重试整个任务。

完成报告必须覆盖全部原验收项。PASSED/FAILED 项必须引用其要求种类的证据，所有证据必须属于本次执行且 AVAILABLE，整体 verdict 必须与逐项结论一致。控制面重写证据 URI，忽略调用方提供的下载地址。同一报告可幂等完成，终态后改写返回 409。

BLOCKED 报告结束任务为 COMPLETED，ERROR 报告结束任务为 ERROR；两者 verdict 为 null，验收项全部 SKIPPED。已取消、超时或出错的执行可用原令牌附加一次 ERROR 报告，但不能提交成功报告或改变终态；lifecycle 由控制面校准。旧报告不可变。失效租约提交故障报告只会停止资源，不授予新权限。

任务详情及公开 v1/v2 case 结果返回可选的 `queueReason: { code, message } | null`，表示最近一次领取检查发现的原因：显式节点与路由冲突、历史同轮快照节点冲突、清理主任务未结束/关联缺失/原节点冲突、资源占用、无合格在线节点、容量已满或凭据轮换。诊断只含固定文案，不输出节点或登录槽身份。领取成功后清空；取消和排队超时后保留，超时错误码为 `TASK_QUEUE_TIMEOUT`。没有被 worker 扫描的任务可能仍为 null，不能据此认定资源可用。迁移 `010-queue-reason.sql` 只新增诊断列，旧自动绑定与登录文件不再用于新任务，升级不自动删除历史记录或本地文件。

`/v2/cases` 每步冻结五分钟；setup 为 10 次动作，verification 预留两次收尾动作并按验收项数增加额度（12 起，每增加一项加 2，最多 30）。模型请求额度为动作数的 2 倍；耗尽后标记受阻并继续后续步骤。整段清理独立三分钟、10 次动作和 20 次模型请求。旧 profile 总预算不再覆盖新 v2，历史快照保持不变。重跑默认使用当前预算策略，可选 budgetMode=original。详见[平台配置](../../docs/case-platform-config.md)。

重跑还可传 `timeBudget: {"stepTimeoutMs":900000,"cleanupTimeoutMs":600000}`，只提高新任务的步骤和清理时间下限，保留动作及请求次数额度。历史快照和全局默认值保持不变；参数及幂等语义见 [v2 协议](../../docs/public-api-v2.md)。

旧任务总预算包含排队，新版步骤额度从领取后开始；每个 task 只有一次 execution。API 支持 DOM、SCREENSHOT、NETWORK 元数据和 TRACE 证据；TRACE 只调度到声明对应能力的节点。节点若关闭写动作则不会被分配需要执行浏览器任务的 worker；开发联调需明确启用节点测试开关，不能由 API 绕过。

## 模块与状态

| 文件                                | 职责                                        |
| ----------------------------------- | ------------------------------------------- |
| `config.ts` / `db.ts`               | 配置、实例锁、迁移和短事务                  |
| `modules/nodes/registry.ts`         | 一次性配对、凭据归属与撤销                  |
| `modules/nodes/gateway.ts`          | 单实例 WebSocket 路由、帧限额与持久化后 ACK |
| `modules/scheduling/coordinator.ts` | 任务、领取、结果处理和有界调度扫描          |
| `modules/scheduling/state.ts`       | 统一结束执行、关闭和容量回收规则            |
| `modules/reports/artifacts.ts`      | DOM 归档、流式 PNG 存储、报告领域校验       |

任务状态：`QUEUED → RUNNING → COMPLETED / CANCELLED / TIMED_OUT / ERROR`。排队也可直接取消或超时。产品 verdict 仅存在于正式执行报告中；基础设施 ERROR 不等于产品 FAILED。

会话状态：`OPENING → ACTIVE → CLOSING → CLOSED`，无法核实关闭则保持 `QUARANTINED`。调度同时计算数据库未关闭会话与节点占用清单的并集，避免重连时重复计算或漏算。

PNG 在核对 SHA-256、文件和目录 fsync、数据库确认后返回存储回执，Node 才删除本地 spool。节点随后发送 `artifact.available`。DOM 作为独立 JSON 证据存入 PostgreSQL。报告校验保证结构与归属，不能代替执行 Agent 对页面语义的判断。

## 验证与后续

```sh
# 使用专用测试实例；测试账户需要 CREATE DATABASE 权限。
PROOFRUN_TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/proofrun pnpm test:api
# 自动创建并回收 Linux systemd 和 PostgreSQL 容器，需要 Docker。
pnpm test:control-plane:linux
```

详细覆盖范围见 [测试入口与覆盖边界](../../tests/README.md)。执行 Agent 已接入，运行方式见 [Agent 说明](../agent/README.md)；Console 已接入，见 [控制台说明](../console/README.md)。当前没有用户 SSO、多租户或生产 VM 验收；API 支持单活动实例的主备切换；已有原配对回执恢复及显式停机记录清理工具；API 重启恢复依赖原数据库和证据磁盘完整。

## Console 读取接口

- `GET /v1/tasks?limit=25&state=QUEUED&q=keyword&reportOnly=false`：管理员查询列表，按 `(created_at,id)` 倒序返回 `tasks` 和 `nextCursor`。页大小 1–100，搜索匹配任务 ID 或目标的字面内容；`reportOnly=true` 只返回有存档报告的任务。后续页带 `cursor`，更改筛选后从第一页开始。游标保留数据库微秒精度，列表目标仅返回前 240 个字符。
- `GET /v1/tasks/:id`：原定义、报告、异常与执行概况；`closure_verified` 独立表示浏览器关闭确认，`action_count` 是已提交写动作数。
- `GET /v1/nodes`：`occupied` 为节点上报与控制面未核实关闭会话的并集计数；不会因终态任务或节点失联直接归零。在线、空闲槽位和可分配某类任务不是同一含义。

读取结构由 `task-list` / `task-detail` / `node-list` JSON Schema 定义并生成类型。保持现有读取字段命名；控制面不返回凭据摘要或执行令牌。管理员响应禁止缓存。列表索引在第二个数据库迁移中创建，不改变原任务定义、调度状态或报告语义。

Console 与 API 通过同源部署或开发代理通信，本批不开放跨源管理员接口。

## 人工控制与维护

节点默认 profile 的管理接口均使用管理员鉴权：`POST /v1/nodes/:id/profile` 接收 `{ "url": "https://example.com" }` 并返回维护身份，`GET /v1/nodes/:id/profile` 返回该节点未关闭的维护身份；`GET /v1/node-profiles/:id` 返回状态和 HITL 入口，`POST /v1/node-profiles/:id/close` 放弃尚未提交保存的维护副本。保存使用现有 HITL 完成动作，不开放普通浏览器发布命令。

维护不会排队交给 Worker。保存状态为 `IDLE / SAVING / SAVED / FAILED / DISCARDED`，物理关闭独立返回 `closed`；节点列表的 `default_profile` 仅含版本、更新时间和维护会话 ID。迁移 `042-node-default-profile.sql` 保留历史维护记录，API 启动时自动执行。API、Console、Node 需要一并升级；普通模板任务只调度到声明 `nodeDefaultProfileVersion=1` 的节点。新任务冻结来源，实际模板版本在节点创建会话时确定；旧冻结定义不回填。

人工交接、操作代次与登录状态见 [HITL 说明](../../docs/hitl.md)，网络证据见 [报告模块](src/modules/reports/README.md)，节点轮换与维护 CLI 见 [部署说明](../../deploy/README.md)。管理员入口位于 `/v1/admin/executions/:id/{activity,intervene,control,commands}`；worker 的安全点确认入口为 `/v1/executions/:id/control`。复用 ControlRequest Schema，不接受调用者指定 fence、session 或租约。

独立免登录 HITL 处理页、实时浏览器画面、受限输入和完成交接现已接入，使用与验证边界见 [HITL 说明](../../docs/hitl.md)。

## 执行模式

`POST /v1/tasks` 只接受省略 executionMode 或显式 llm；任务 Schema 拒绝旧模式和 comparison 字段。比较创建和查询接口均已删除，返回 404。迁移 043 物理删除退役任务、关联执行、报告、调用与证据记录，保留正常单 LLM 源任务和混合请求中的正常成员。未确认资源关闭时迁移回滚。

## 执行原因与人工等待

任务生命周期 `state` 保持兼容，列表、详情及 v2 case 额外返回 `executionOutcome`。`category` 区分环境阻塞、人工等待/超时、预算耗尽、排队/执行超时、执行器/节点/浏览器/模型/清理故障；未知错误保持未分类。`reasonCode` 保留主要原因，`terminationCode` 独立说明结束机制，二者不改变产品验收结论。未完成的当前人工请求若明确缺少环境条件，会话关闭不会覆盖该阻塞；已交还控制权的旧请求不参与后续故障分类。

`PROOFRUN_HUMAN_WAIT_MS` 默认 1800000 毫秒（30 分钟），范围 1000–86400000。每次进入 REQUESTED 时持久化开始/截止时间，重复请求、acknowledge 和人工链接轮换不延长截止时间；恢复成功会清空本轮时钟。到期关闭会话并记录 `HUMAN_INTERVENTION_TIMEOUT`，未验收内容不能视为产品失败。旧人工请求没有独立截止时间时不回填、不追溯判超时。业务与清理预算、执行器及节点租约仍独立生效。

升级顺序：先部署带 019 迁移与可选 `closeReason` 接收能力的 API，再更新 Console 和 Browser Node。新节点将首个关闭触发原因写入 SQLite 和关闭事件；旧节点或旧记录缺失时显示未知，不根据最后一次清理命令的错误倒推关闭原因。新增分类不要求修改旧报告或任务状态枚举。

## 运行历史与软删除

升级执行 `032-case-runs.sql`：新增独立删除标记及运行视图，旧 taskId 原样作为首轮 runId，不改写报告、证据或冻结请求成员。历史上已经复制成不同 caseId 的重跑仍是不同 case，不按标题或步骤猜测合并。

`POST /v2/cases/:id/rerun` 接收 `{ "runId": "稳定重试键" }`，保留业务 caseId，返回本轮 `taskId` 和 `runId`。`GET /v2/cases/:id` 默认读取最新未删除运行；指定 `?runId=返回的运行身份` 可读取历史，`GET /v2/cases/:id/runs` 返回历史列表。新旧任务身份空间隔离；原内部任务调度和证据绑定不变。旧重跑参数 `caseId` 兼容解释为运行幂等键，不再复制业务 case。

管理员可使用 `POST /v1/tasks/:id/delete` 或 `POST /v1/tasks/delete` 的 `{ "ids": [...] }` 删除运行，最多 100 个身份，整批原子处理。关联的历史独立清理随整轮删除；运行中、清理待执行或会话未核实关闭时返回 409。重复删除幂等，已删除运行不能通过重试键复活。任务详情、列表、报告及统计均排除已删除记录，最新运行删除后回退到前一条可见运行。

请求对应 `/v2/requests/:id/delete` 和 `/v2/requests/delete`。删除请求只删除不再被其他可见请求引用的运行；直接删除运行会刷新所有关联请求的汇总。请求成员绑定当前选定的运行。`POST /v2/requests/:id/rerun` 省略新 requestId 时，在原请求内原子重跑一个或全部成员，并将报告切换到新运行；旧记录保留。显式传新 requestId 的旧客户端仍创建独立请求。升级需执行 `035-request-reruns.sql` 保存重跑幂等记录。

业务统计排除已删除运行的调用明细、旧报告汇总及清理用量。原始事实保留，迟到回执不会重新进入统计。

## 执行收敛升级

迁移 `033-current-execution.sql` 为请求提供统一读取视图；新单 LLM 请求只写一次 cases 关联；迁移 043 删除退役模式记录及旧 arms 表。当前任务的业务清理在 profile 内执行，不再生成独立清理或使用 resourceKey 调度锁；原始任务提交携带 resourceKey 时明确返回 422 RESOURCE_LOCK_RETIRED。历史排队原因及清理记录仅用于读取旧报告。

若存在尚未处理的独立清理意图、排队/执行中的旧清理任务或未确认关闭的清理浏览器，迁移会以 `LEGACY_CLEANUP_PENDING` 阻止启动并回滚。须先在旧版本完成清理，或经业务判断明确处理遗留意图并核实关闭，再升级；新版本不会自动将这些记录标为跳过。带显式资源锁的原始任务若仍在排队或执行，会以 `LEGACY_RESOURCE_LOCK_PENDING` 阻止升级，须由旧版本排空。旧模板入口返回 410，历史 ID 仍可读取任务链接、通过通用取消流程关闭会话。Agent 内部 progress 决策协议须与 Contracts 同步部署。

## 节点直连

API 不再代理实时画面或 HITL 输入。`POST /v1/hitl/bootstrap` 用处理链接换取会话限定的节点地址和一次性凭据；`POST /v1/admin/executions/:id/live` 为管理员签发只读画面凭据。Node 经主 WSS 连接接收能力摘要，客户端再连接节点 `/hitl/control`、`/hitl/frames` 或 `/live/frames`。人工结果和完成事件经可靠节点通道持久化，操作摘要同时进入活动记录与时间线。

调度只读取节点的 `admission` 作为候选提示，并串行同节点创建握手；最终准入由 Node 检查 CPU/内存。迁移 036 删除历史 `capacity` 列，节点心跳和列表契约同步移除此字段；`occupied` 仅用于占用展示和候选排序，不设固定并发上限。`NODE_CAPACITY` 排队原因表示节点暂不接收新任务。Case 内的 `profilePlan.maxConcurrency` 保持不变。域名唯一配置来源是节点 `public_url`，具体迁移见[部署说明](../../deploy/README.md#节点直连域名与升级)。

## 通用浏览器任务

`POST /v1/browser-tasks` 使用 Admin 认证，正文为 `{ "taskId": "browser-稳定重试身份", "url": "https://example.com", "objective": "查询价格并整理为表格" }`，返回 202 和任务详情。不接受环境、预算、验收项等客户端配置；内部冻结 `taskKind: browser`、LLM 模式和空验收集合。

调度位置与人工权限优先使用 `caseProfile.environment` 的 id、nodePool、allowIntervention，预算优先使用 `caseProfile.budget`。未配置时使用 default/internal、允许人工辅助、二十分钟和一百次动作；浏览器任务仍使用空白会话。普通验证任务默认复制分配节点的默认 profile，明确访客和 DevPass 保持空白会话。相同 taskId 和业务输入重试沿用首次冻结的配置；身份冲突返回 409。重跑沿用原配置并创建新任务身份。

通过 `GET /v1/tasks?taskKind=browser` 搜索和分页，详情、重跑、取消、删除及证据继续复用原任务接口。浏览器结果保存在 `report.browserResult`，包含 `outcome: COMPLETED | INCOMPLETE`、`output` 和 `evidenceRefs`，`verdict`、`reportStatus`、`criteriaCounts` 均为 null。完成必须交付正文及本次执行的证据；API 检查证据归属和协议一致性，不独立证明模型的业务判断。验证看板不纳入浏览器任务的数量与用量。

未带 taskKind 的历史任务和 v2 Case 继续采用原验收语义，完整内部提交入口不能绕过浏览器任务的服务端配置。此次变更复用 JSON 定义与报告存储，无须数据迁移；API、Agent 和 Console 应配套部署，旧 Agent 不支持浏览器任务完成协议。

## MCP 操作工具与 Codex 执行流程

Browser MCP 在原 6 个任务工具上增加 10 个操作工具；Verification MCP 在原 9 个任务工具上增加 7 个操作工具。两个目录各 16 个工具，`tools/list` 按当前凭据授权过滤；直接调用隐藏工具仍会检查 scope 和 channel。每个工具的 inputSchema/outputSchema 自包含，错误输出也符合 outputSchema。工具目录和校验器从 [底层契约派生](../../contracts/src/mcp-execution.ts)，业务调用复用 HTTP 的 `ExternalExecution`，不会创建第二套操作账本。

以下决定信封统一为 `{controllerId, operationId, expectedRevision, observationId, stepId?, decision}`。controllerId 取绑定回执，版本和观察取最新 context；正式验证必须带当前 stepId。decision 使用每个工具明确限定的 AgentDecision 分支，保留 `type`。正文不接受 report、leaseToken、principalId 或额外执行配置。

| Browser MCP 新工具       | 输入                                                                                                | 权限与结果                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `browser_session_open`   | `{operationId,taskKey,url,objective}`                                                               | browser:control；创建通用 external 运行，返回操作回执和 controllerId      |
| `browser_session_get`    | `{controllerId}`                                                                                    | runs:read；读取通用或同 principal 正式验证上下文；不续期                  |
| `browser_session_touch`  | `{controllerId,operationId}`                                                                        | browser:control；正式绑定另需 verification:control；重复键不再次续期      |
| `browser_session_finish` | 决定信封，`decision.type=verification.finish`                                                       | browser:control；仅通用目标，summary 交付正文，progress.requirements 留证 |
| `browser_session_close`  | `{controllerId,operationId}`                                                                        | browser:control；仅取消通用运行，继续查询 closureVerified                 |
| `browser_observe`        | 决定信封，`decision:{type:"browser.observe",screenshot?,progress?}`                                 | browser:control；观察后从新 context 读取页面，证据用 evidence_read        |
| `browser_act`            | 决定信封，`decision:{type:"browser.act",action,...}`                                                | browser:control；有限动作参数和 target 按发现契约及当前观察填写           |
| `browser_wait`           | 决定信封，`decision:{type:"browser.wait",selector,text,progress?}`                                  | browser:control；条件等待也受预算和单个在途决定限制                       |
| `browser_network_list`   | 决定信封，`decision:{type:"network.requests",observationId,urlContains?,status?,offset?,progress?}` | browser:control；读取已采集的分页摘要，不请求站点；消耗决定额度           |
| `browser_network_detail` | 决定信封，`decision:{type:"network.request_detail",observationId,requestId,progress?}`              | browser:control；已采集详情，结果位于新 context.page.network              |

网络工具外层 observationId 绑定 page，内层绑定 page.network。所有正式验证的浏览器决定若携带非空 progress，还需要 verification:control。通用浏览器不能用正式验证工具收尾；正式验证不能用 browser_session_finish/close，取消使用 verification_cancel_run。

| Verification MCP 新工具             | 输入                                                                                     | 权限与结果                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `verification_bind_run`             | `{runId,operationId}`                                                                    | verification:control；仅绑定本调用方提交的 external 正式 Case    |
| `verification_get_context`          | `{controllerId}`                                                                         | runs:read；正式验证上下文、报告及关闭状态                        |
| `verification_touch_controller`     | `{controllerId,operationId}`                                                             | verification:control；续正式绑定的空闲期限，不重置预算           |
| `verification_record`               | 决定信封，`decision:{type:"verification.record",summary,progress}`                       | verification:control；保存当前步骤的部分验收                     |
| `verification_finish_step`          | 决定信封，`decision:{type:"verification.finish",summary,progress?,evidenceRefs?}`        | verification:control；核实并推进阶段，平台构建最终报告           |
| `verification_block_step`           | 决定信封，`decision:{type:"verification.block",summary,reasonCode?,progress?}`           | verification:control；声明当前步骤受阻并保留已保存进度           |
| `verification_request_intervention` | 决定信封，`decision:{type:"verification.intervene",reason,reasonCode?,items?,progress?}` | verification:control；请求平台人工处理，不提供人工确认或恢复出口 |

原 `browser_operation_get` / `verification_operation_get` 同时接受任务操作和直接执行操作的 UUID，保留两种既有回执形状。HTTP 和 MCP 的同一 operationId、同一底层参数共享幂等结果；更换工具不能绕过权限、类型限制或幂等冲突。所有决定工具 `readOnlyHint=false`，包括消耗决定额度的观察和网络读取；上下文读取为 true。MCP 的成功响应仅表示操作已登记，需查询原 operationId。

读取上下文时，以 `budget.timingState=live` 的 `timeMs`（步骤余额）、`decisionTimeMs`（本轮提交余额）及 `stepDeadlineAt/decisionDeadlineAt`（UTC）安排调用；inactive 表示历史帧。GET 和 touch 均不增加步骤预算。`SETTLEMENT_REQUIRED` 提示进入只读收尾，应先保存已有结论，再 finish/block；每项独立验收取得证据后应及时 record，不等待整步最后一刻。

`page.coverage` 区分源采集与投影裁剪，包含正文原始/返回字符数及控件细节裁剪标记；按 artifactRefs 使用 evidence_read 分页取回原始已采集内容，旧附件目标不能用于操作。`page.network.capture.coverage` 提供显式范围、完整性、窗口时间和排除项；范围内 complete 不表示全页面完整，也不表示已读完所有分页。旧节点返回 COVERAGE_UNAVAILABLE，空筛选结果不能自动成为“无请求”的通过依据。详见[真实联调修复设计](../../docs/mcp-execution-design.md#13-生产-mcp-联调反馈与修复设计2026-10-28)。

Codex 通过 MCP 完成正式验证：

1. 在两套端点读取 tools/list 和 capabilities；授权同一 principal 的两个 channel。可分别使用 Browser 和 Verification 凭据，跨工具附带进度时使用同时具备两个 control scope 的凭据。
2. 用 verification_validate_cases 和 verification_submit_cases 提交 `executor:{kind:"external"}`，再用 verification_bind_run 绑定回执里的精确 runId。
3. 用 verification_get_context 等待 ACT，按当前 allowedActions、原始标准、预算及观察判断下一步。浏览器动作只使用当前 targets；每次变更生成一个稳定 operationId。
4. 调用 Browser MCP 的 observe/act/wait/network 工具，或 Verification MCP 的 record/finish_step/block_step/request_intervention。下面是正式步骤的一次观察请求（身份字段须替换为当前返回值）：

   ```json
   {
     "name": "browser_observe",
     "arguments": {
       "controllerId": "da7459ec-761b-4efc-8b59-9d05103af690",
       "operationId": "98fd93ec-ea59-4895-8371-1e9f68b8bb21",
       "expectedRevision": 3,
       "observationId": "当前context.page.observationId",
       "stepId": "check",
       "decision": { "type": "browser.observe", "screenshot": true }
     }
   }
   ```

5. 查询 operation_get 至终态，然后重读 context。网络超时保留同一键找回回执；UNKNOWN 不换键重放，FAILED 且 progressApplied=true 时先检查已保存进度。截图使用 evidence_read 的 content 表示，MCP 返回原生 image 内容；不要把文字摘要当成图像交付。
6. PREPARING 完成后 finish_step 进入 CHECKING，以新证据核实原 policy；VERIFYING 先 record 再 finish_step；CLEANUP 同样完成实际操作并提交新 evidenceRefs。HUMAN_REQUIRED 期间等平台人工交还，然后重读观察和版本；GET 不续期，按需 touch_controller。
7. 最后读取 get_context/get_run 的最终报告、清理和 closureVerified。报告中的 external_agent 表明判断来自外部 Agent，平台没有独立复验其自然语言结论。通用任务则使用 session_open → browser 操作 → session_finish → session_get。

启用沿用现有凭据文件与迁移，不新增部署入口。完整流程通常需要 browser:control、verification:submit、verification:control、runs:read、evidence:read，以及取消时的 runs:cancel。现有只读/委托凭据不会自动获得 control 权限。未配置公共凭据时，两套 MCP 和公共 HTTP 路由均不注册。

运行 `PROOFRUN_TEST_DATABASE_URL=... pnpm test:agent:integration` 包含 [MCP 执行回归](../../tests/agent/execution-mcp.test.mjs)：真实 SDK、PostgreSQL、跨端点权限、严格参数、HTTP/MCP 混合幂等、原生图像、网络读取、正式 Case 全流程、受阻和人工介入。上述自动化回归中的浏览器和判断由夹具模拟。另有 [真实 Codex / Chromium 联调入口](../../tests/mcp-real/README.md)：已通过真实 Codex CLI、Rust Node/systemd 和 Chromium 的完整准备、核验、操作、清理及报告闭环；该入口包含独立页面副作用审计，不替代外部站点或生产身份验收。

### Codex 本地接入

Mac 本地启动器从 `.proofrun/local.env` 向 API 传递 `PROOFRUN_MCP_CREDENTIALS_FILE`（0600 摘要文件），不会向 API 或 Console 传递客户端明文令牌。外部执行无需启动内置 Agent，可用 `pnpm dev:local -- --no-agent`。配置文件改变后需重启空闲 API。

Codex 的两个 HTTP 端点使用各自 token 环境变量；同一调用方的两个凭据必须使用相同 principalId。按实际服务地址配置：

```toml
[mcp_servers.proofrun_browser]
url = "http://127.0.0.1:4101/mcp/browser"
bearer_token_env_var = "PROOFRUN_BROWSER_MCP_TOKEN"
required = true
startup_timeout_sec = 30
tool_timeout_sec = 60

[mcp_servers.proofrun_verification]
url = "http://127.0.0.1:4101/mcp/verification"
bearer_token_env_var = "PROOFRUN_VERIFICATION_MCP_TOKEN"
required = true
startup_timeout_sec = 30
tool_timeout_sec = 60
```

交互运行按 Codex 的工具审批策略处理写调用。已授权的无人值守联调需要在这两个服务器块中分别增加 `default_tools_approval_mode = "approve"`；只设置 `approval_policy="never"` 会使需要审批的写工具被拒绝。真实联调脚本自动生成独立配置与 token 环境文件，并验证写工具实际成功；不会改写用户的全局配置。参数依据 [OpenAI MCP 配置说明](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

## 外部 Agent 直接执行 API

迁移 `041-external-execution.sql` 增加控制绑定和操作账本。配置沿用 `PROOFRUN_MCP_CREDENTIALS_FILE`：直接浏览器执行需要 `browser:control` 与 browser channel；正式验证提交、绑定及进度需要 `verification:submit`、`verification:control` 与 verification channel。完整流程通常为同一 principal 授予两个 channel，以及这三个 scope、`runs:read`、`evidence:read`。在正式验证中，浏览器动作附带非空 progress 时同时需要两个 control scope。管理员/worker token、controllerId 都不能充当外部凭据。

所有请求使用 `Authorization: Bearer <公共令牌>`；同源、Host 检查和 no-store 规则与任务 MCP 相同。输入、输出分别见 [ExternalExecutionRequest](../../contracts/schemas/external-execution-request.schema.json)、[ExternalExecutionResult](../../contracts/schemas/external-execution-result.schema.json)。`GET /v3/execution/schema` 返回输入、封闭 AgentDecision 和输出规范；HTTP 正文省略 schema 中内部判别字段 `type`。所有变更都要求稳定 UUID `operationId`，不同输入不能复用同一键。

| 路径                              | 方法及参数                                    | 语义                                                                                    |
| --------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `/v3/browser/sessions`            | POST `{operationId, taskKey, url, objective}` | 复用浏览器任务服务，原子创建 external 运行及绑定，返回 202 操作回执                     |
| `/v3/runs/:runId/controller`      | POST `{operationId}`                          | 绑定同 principal 已提交的 external Case；不转换 builtin 运行                            |
| `/v3/controllers/:id`、`/context` | GET                                           | 返回 revision、当前上下文、allowedActions、nextAction、在途操作、报告及关闭状态；不续期 |
| `/v3/controllers/:id/touch`       | POST `{operationId}`                          | 延长空闲期限，不重置任何执行预算                                                        |
| `/v3/controllers/:id/close`       | POST `{operationId}`                          | 取消此运行；仍需读取 closureVerified，不能把关闭请求当成物理关闭证明                    |
| `/v3/controllers/:id/decisions`   | POST 决定信封                                 | 单个封闭意图；共享执行器负责实际操作、阶段门禁及报告                                    |
| `/v3/operations/:operationId`     | GET                                           | 查询原回执；RUNNING/SUCCEEDED/FAILED/UNKNOWN，与最终业务结论独立                        |

决定信封为 `{operationId, expectedRevision, observationId, stepId?, decision}`。前三个上下文字段取自最近一次可操作视图；正式步骤必须传当前 stepId。`decision` 使用现有 AgentDecision：浏览器观察、有限动作、等待、网络证据读取，以及 verification.record/finish/block/intervene。不接受最终 report、租约、任意 JavaScript、shell、原始 Cookie 或环境配置。

便于客户端路由的 POST 别名均接受同一信封：`/observations` 只接收 browser.observe，`/actions` 接收 browser.act，`/waits` 接收 browser.wait，`/network` 接收 network.requests/request_detail，`/finish` 接收 verification.finish，`/interventions` 接收 verification.intervene；`/steps/:stepId/progress`、`/finish`、`/block` 分别接收 verification.record/finish/block，路径与正文 stepId 必须一致。网络读取也使用 POST 和操作键，从而计入决定预算。

例如，Codex 根据当前 DOM 和 targets 操作页面：

```json
{
  "operationId": "9bdc443e-c994-499c-82f4-053418cf2f8d",
  "expectedRevision": 3,
  "observationId": "从context.page.observationId读取",
  "stepId": "check",
  "decision": {
    "type": "browser.act",
    "action": "click",
    "target": "当前targets中的target"
  }
}
```

Codex 直接完成正式验证的顺序：

1. 读取能力与 schema，用 `executor:{kind:"external"}` 预检、提交 `/v3/verification/requests`；Case 和环境规则沿用原服务。
2. 用回执中的精确 runId 绑定 controller。未绑定运行最多等待十分钟（仍受原任务期限限制），不申请账号、不分配浏览器，也不由 builtin Worker 领取。
3. 轮询 context，直到 `nextAction=ACT`。读取 task 原始要求、state 阶段、page 观察/targets、budget 和 allowedActions。截图、DOM 与网络附件通过同 principal 的 `/v3/runs/:runId/evidence/:evidenceId` 读取；外部上下文已经交付的当前证据也可读取。
4. 保留稳定 operationId 提交一个决定。HTTP 202 只代表登记；轮询 operation，随后重新读取 context。同 controller 只有一个决定在途。发生超时或断线先读原操作，不能用新键重放未知效果的动作。
5. 在 PREPARING 完成准备要求，finish 后进入 CHECKING 并取得新观察，再核实原 policy。CHECKING 禁止 browser.act。在 VERIFYING 用 record 保存部分结论，用 finish 结束当前步骤；CLEANUP 仍由外部 Agent 完成。无验收项的准备/清理 finish 仍需要本步骤的 evidenceRefs。服务端验证证据归属、门禁和预算。
6. 最后继续查询 controller 和 run，区分最终报告、清理状态及 `closureVerified`。外部报告标记 `executor.kind=external`、`judgmentSource=external_agent`；decisionCalls 为已准入决定数，外部模型/token 用量为 null、usageSource=unavailable。旧 executionDetails 的 modelCalls/token 为平台用量 0，不能解释成 Codex 没有使用模型。

合法 progress 先持久化，后续动作失败时 operation 可返回 `FAILED` 且 `progressApplied=true`。`effect` 为 NOT_STARTED/OBSERVED/APPLIED/UNKNOWN；RUNNING 默认 UNKNOWN，不能按 202 推断副作用。控制/认证代次或观察失效返回冲突；重新读 context 再判断。人工控制期间返回 HUMAN_REQUIRED，外部 Agent 不能自行批准人工条件或恢复控制。

绑定默认五分钟无外部活动后失效；GET 不续期，明确 touch/新决定会续期。平台正在处理决定、Case 显式等待及人工交接期间暂停空闲回收，步骤、任务、账号和人工等待期限仍由原执行层约束。过期、关闭或 LOST 绑定不能复活；原幂等回执仍可查询。API 重启终止原进程栈，遗留操作标 UNKNOWN，不从快照重放动作，也不调用内置模型代跑。external profile 分组固定串行，任务级 rerun 拒绝 external 来源；当前重新验证需新 Case 身份和新 controller。

实现分工：`external-execution/routes` 解析 HTTP；`service` 管理归属、scope、版本和幂等；`engine` 将外部决定接入共享 DecisionModel 端口；实际命令、截图校验、步骤记录和报告提交复用 `RuntimeDriver`。既有内置 Agent 路径不读取外部决定，也不接管外部租约。

回归执行 `PROOFRUN_TEST_DATABASE_URL=... pnpm test:agent:integration` 与 `pnpm test:api`。外部回归覆盖完整 Case、浏览器操作、权限组合、重复派发、进度保存、未知效果、人工接管、期限及重启恢复；使用真实 API/PostgreSQL 和模拟节点，不构成真实 Chromium、DevPass 或外部模型验收。
