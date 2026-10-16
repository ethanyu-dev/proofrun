# proofrun-api

ProofRun 的最小控制面：接收上层已定义的任务，持久化全局队列和节点容量，通过内网节点主动建立的 WebSocket 下发操作，保存执行事实、证据与最终报告。没有 Spec Runtime，也不运行模型。

上层调用方只需 [Case API](../../docs/public-api.md)，或导入 [OpenAPI](../../contracts/public-api.openapi.json)。平台维护者先设置 [case 执行配置](../../docs/case-platform-config.md)。下文的任务、worker、节点运维和 Console 接口属于内部协议。

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

以下里程碑各发送一条新卡片，同时把同一 Case 本轮已发卡片更新为当前状态。每张卡片保留原始事件、组别、原因及发生时间，便于回看过程：

- 提交：单任务发送一次；双组比较按 `comparison.id` 聚合为一次。
- 进入 HITL：每组每一轮人工请求发送一次；确认接管不重复发送。
- 恢复执行：每次从人工处理恢复自动执行发送一次。
- 执行结束：两组均结束后发送一次，分别展示完成、取消、超时、错误及验收结论；结束不等于验收通过。

卡片沿用 Console 的中文状态、验证目标、Case ID、分组和验收口径，显示北京时间的处理截止。有效请求提供「立即处理」，结束、过期或会话失效后移除操作入口；后续新一轮 HITL 会显示新入口。报告生成后「查看任务」切换为「查看报告」。立即处理沿用现有任务专属 HITL 链接，群成员持链接即可操作本次会话；查看任务或报告仍需要 Console 管理员认证。长文只展示摘要，完整内容以处理页为准。

首次启用只通知启用后提交的 Case，不补发历史任务，节点模板维护和独立清理任务不推送。同一应用和群的通知起点、事件、发送回执及每张卡片更新进度持久化；重启后补齐期间发生的里程碑，即使多轮状态变化快于轮询也不会遗漏事件。切换应用或群会建立独立通知起点，不能跨群更新旧卡片。沿用同一配置停用后再启用会补齐该起点之后的事件。

扫描与业务调度独立，每秒轮转一个 Case，最多发送一张新卡片、更新三张旧卡片，更新为最终一致。单次 HTTP 最多五秒；失败按 10、20、40、80 秒退避，总计最多五次。某张旧卡片失败不影响其他卡片，当前状态发生变化时可重新尝试该卡片的新版本。日志只含内部通知 ID、次数及数值错误码。

首次发送前冻结内容与 UUID，回执丢失时复用它们重试。飞书发送去重窗口为一小时，本实现首次尝试超过 55 分钟后停止未知结果重发；不能承诺无限期严格一次送达。旧卡片只可更新发送后十四天内的消息，已删除或撤回的消息也会停止更新。达到重试上限会留存记录并告警；修复故障后，维护者可按 `pr_feishu_messages.id` 精确重置对应发送或更新的次数及下次时间，并清空其 `pr_feishu_runs.settled_at`，但不要重置首次发送时间以绕过去重窗口。

从旧 webhook 方案升级时移除 `PROOFRUN_FEISHU_WEBHOOK_URL` 和 `PROOFRUN_FEISHU_SIGNING_SECRET`，改配上述应用变量。只配置旧变量时 API 会提示迁移。迁移 `023` 的旧投递记录保留，`024` 增加应用消息进度表；自建应用无法接管旧 webhook 已发卡片。

`feishu.test.ts` 验证应用配置、令牌刷新、卡片结构、回环 HTTP 与错误脱敏；`feishu-lifecycle.test.ts` 在独立 PostgreSQL 验证迁移、四类事件、双组聚合、重启恢复、独立重试和链接失效。它们不连接真实飞书群，不代表飞书客户端渲染、应用权限或生产网络已验收。

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
- 命中后只分配到指定节点，仍检查容量、能力、凭据状态和 `environment.auth.nodeId`。节点离线、满载、撤销或显式登录节点冲突时继续排队，达到原任务截止时间后超时；不会绕过命中的路由。自动登录槽的历史节点仅是偏好，路由可覆盖；未命中路由时，偏好节点不可用或满载允许选择其他节点。启用登录复用的同轮对照固定到首组分配的节点，以保持本地初始快照一致。
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

任务详情及公开 v1/v2 case 结果返回可选的 `queueReason: { code, message } | null`，表示最近一次领取检查发现的原因：显式节点与路由冲突、同轮快照节点冲突、清理主任务未结束/关联缺失/原节点冲突、资源占用、无合格在线节点、容量已满或凭据轮换。诊断只含固定文案，不输出节点或登录槽身份。领取成功后清空；取消和排队超时后保留，超时错误码为 `TASK_QUEUE_TIMEOUT`。没有被 worker 扫描的任务可能仍为 null，不能据此认定资源可用。迁移 `010-queue-reason.sql` 只新增诊断列，已有自动绑定会直接按新偏好语义读取，无需清空绑定或登录文件。

`/v2/cases` 每步冻结五分钟；setup 为 10 次动作，verification 按验收项数增加动作额度（10 起，每增加一项加 2，最多 30）。模型请求额度为动作数的 2 倍（JEV 再翻倍）；耗尽后标记受阻并继续后续步骤。整段清理独立三分钟、10 次动作和 20/40 次模型请求。旧 profile 总预算不再覆盖新 v2，历史快照保持不变。重跑默认使用当前预算策略，可选 budgetMode=original。详见[平台配置](../../docs/case-platform-config.md)。

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

人工交接、操作代次与登录状态见 [HITL 说明](../../docs/hitl.md)，网络证据见 [报告模块](src/modules/reports/README.md)，节点轮换与维护 CLI 见 [部署说明](../../deploy/README.md)。管理员入口位于 `/v1/admin/executions/:id/{activity,intervene,control,commands}`；worker 的安全点确认入口为 `/v1/executions/:id/control`。复用 ControlRequest Schema，不接受调用者指定 fence、session 或租约。

独立免登录 HITL 处理页、实时浏览器画面、受限输入和完成交接现已接入，使用与验证边界见 [HITL 说明](../../docs/hitl.md)。

## 执行模式

`POST /v1/tasks` 接受 `executionMode: "llm" | "jev" | "parallel"`。前两者分别创建一个纯 LLM 或 LLM + JEV 任务；省略字段保持旧单任务行为。`parallel` 在同一事务中创建 `<taskId>-llm` 和 `<taskId>-jev`，返回前者的任务详情，不额外运行来源任务。两组携带实际执行模式和服务端生成的 `comparison` 标识；直接并行创建时 `sourceTaskId` 为提交身份，不对应第三条任务记录。

并行提交 ID 限制为 100 字符，每组各自使用原预算和验收标准。两组从同轮次的不可变初始登录快照创建独立会话，支持自动和显式登录槽；一组登录后不会即时改变另一组。相同身份、相同定义重复提交不会多建任务；变更模式或定义返回冲突。单组重跑保留执行模式，对照重跑仍创建两组。更新此协议后应同时更新并重启 API 与 Agent，避免旧 worker 将单组 JEV 按 LLM 执行。

## 执行原因与人工等待

任务生命周期 `state` 保持兼容，列表、详情及 v2 case 额外返回 `executionOutcome`。`category` 区分环境阻塞、人工等待/超时、预算耗尽、排队/执行超时、执行器/节点/浏览器/模型/清理故障；未知错误保持未分类。`reasonCode` 保留主要原因，`terminationCode` 独立说明结束机制，二者不改变产品验收结论。未完成的当前人工请求若明确缺少环境条件，会话关闭不会覆盖该阻塞；已交还控制权的旧请求不参与后续故障分类。

`PROOFRUN_HUMAN_WAIT_MS` 默认 1800000 毫秒（30 分钟），范围 1000–86400000。每次进入 REQUESTED 时持久化开始/截止时间，重复请求、acknowledge 和人工链接轮换不延长截止时间；恢复成功会清空本轮时钟。到期关闭会话并记录 `HUMAN_INTERVENTION_TIMEOUT`，未验收内容不能视为产品失败。旧人工请求没有独立截止时间时不回填、不追溯判超时。业务与清理预算、执行器及节点租约仍独立生效。

升级顺序：先部署带 019 迁移与可选 `closeReason` 接收能力的 API，再更新 Console 和 Browser Node。新节点将首个关闭触发原因写入 SQLite 和关闭事件；旧节点或旧记录缺失时显示未知，不根据最后一次清理命令的错误倒推关闭原因。新增分类不要求修改旧报告或任务状态枚举。
