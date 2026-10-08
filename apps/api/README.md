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
- 命中后只分配到指定节点，仍检查容量、能力、凭据状态和 `environment.auth.nodeId`。节点离线、满载、撤销或登录节点冲突时继续排队，达到原任务截止时间后超时；不会改派其他节点。
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

当前任务总预算包含排队；每个 task 只有一次 execution。API 支持 DOM、SCREENSHOT、NETWORK 元数据和 TRACE 证据；TRACE 只调度到声明对应能力的节点。节点若关闭写动作则不会被分配需要执行浏览器任务的 worker；开发联调需明确启用节点测试开关，不能由 API 绕过。

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
