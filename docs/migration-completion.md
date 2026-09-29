# 本轮迁移交付与验收边界

本轮按 ProofRun 新架构补齐业务执行与节点运维入口，没有恢复 Spec Runtime，没有迁移旧库数据或引入兼容层。任务、目标、验收项仍由上层定义。以下“已实现”是代码和本地测试范围，不能代替真实模型、真实内网 VM 或业务验收。

## 本轮交付

| 能力         | 实现                                                                                         | 验证边界                                                          |
| ------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 节点管理     | Console 注册配对码、撤销、空闲节点凭据轮换                                                   | HTTP/数据库/WS 集成与界面检查；生产 TLS 未验收                    |
| 配对回执恢复 | 同一有效配对码只取回同一节点的同一凭据，不能绑定第二个节点                                   | 重复、跨节点和旧凭据拒绝测试                                      |
| 人工介入     | 管理员或模型请求，worker 安全点交接，人工受限操作，恢复后重新观察                            | API、真实执行 Agent 和脚本模型闭环；非远程桌面或视频流            |
| 登录复用     | 任务绑定 nodeId/stateId；独立 profile 载入 Cookie/localStorage；人工保存或节点 CLI 导入/删除 | 真实 Chrome 跨会话存储恢复；不证明业务 SSO/MFA 有效               |
| 网络证据     | 导航前启用采集，按观察窗口交付脱敏元数据、摘要、报告引用和预览                               | 真实请求状态码及脱敏；不支持请求/响应体或完整 HAR；TRACE 单独采集 |
| 执行追踪     | 最近操作、人工交接原因、角色、状态、效果和实时证据                                           | 不把自动续租流水作为业务操作列表                                  |
| 保留策略     | API 停机维护清理过期证据与命令内容；节点清理已关闭且已确认交付的 profile                     | 默认预览，显式 apply；保留轻量身份和去重键                        |
| 重启恢复     | 节点显式 recover-reboot 核实启动周期变化和旧 unit 非活动                                     | 工具已实现，实际 VM 断电/重启演练仍待做                           |
| 部署和验收   | API/Agent/Node 用户服务、同源代理模板、真实任务验收导出命令                                  | 配置模板不等于已在生产部署                                        |

## 人工操作权

`AUTO → REQUESTED → HUMAN → AUTO` 是同一次执行的控制权状态，不是新的任务生命周期。管理员和模型均只能为 `environment.allowIntervention: true` 的任务请求人工辅助。REQUESTED 立即阻止新自动操作；worker 等在途命令完成，在安全点确认后进入 HUMAN。只有管理员能恢复 AUTO。

暂停和恢复都更新 controlRevision。命令及报告绑定该代次；旧页面不能在新的人工会话里操作，旧模型回复不能在人工改动后继续执行。恢复后重新观察，重新进行模型判断。所有人工动作共享原 maxActions 和 deadline；原 worker 必须持续续租。worker 丢失、取消或总预算耗尽都会停止执行，不以人为活动延长权限。

Console 提供观察/截图、导航、点击、填写、按键、滚动和保存绑定登录状态；不提供任意脚本、shell、CDP 地址或直接会话续租。页面操作不能更改验收项，人工也不能直接写入 PASSED 结论。命令输入和 DOM 可能含业务内容，管理员接口仍需部署在受控入口；登录快照本身不上传控制面。

## 登录状态

上层任务可选择：

```json
{
  "environment": {
    "id": "staging",
    "nodePool": "internal",
    "allowIntervention": true,
    "auth": {
      "nodeId": "registered-node-id",
      "stateId": "qa-account",
      "restore": true
    }
  }
}
```

首次人工登录用 `restore: false`，任务进入人工控制后完成登录，再点击保存当前登录状态。后续任务用 `restore: true`。状态保存在对应节点 `home/auth/qa-account.json`，文件 0600、目录 0700，原子替换；每次执行仍创建独立 profile。任务队列只会选择指定节点，同一个 stateId 在原会话确认关闭前不分配第二个会话。

也可在停止节点后导入已有存储状态：

```sh
proofrun-node --config /etc/proofrun/node.toml auth-import --state-id qa-account --file /private/auth.json
proofrun-node --config /etc/proofrun/node.toml auth-forget --state-id qa-account
```

导入文件必须仅运行用户可读，且包含 cookies/origins。状态失效时由模型请求人工或明确阻塞，不自动提交登录口令，不保证 sessionStorage、跨域 SSO、设备绑定或 MFA 的跨会话有效性。

## 网络证据

要求 NETWORK 的任务只能分配到声明 networkEvidence 的节点。记录包含去除账号、查询参数和片段的 URL、method、status、resourceType、timestamp；没有 Cookie、认证头、请求体和响应体。单次最多 100 条，证据明确标记窗口、截断和非完整捕获。网络日志在每次观察后清空，尚未收到状态码的请求可能为 null；不得根据日志缺失断言网络调用从未发生，也不能据此证明服务端只写入一次。

该实现核对固定版本 [agent-browser 0.38.1 原生请求实现](https://github.com/vercel-labs/agent-browser/blob/v0.38.1/cli/src/native/actions.rs) 和 [存储状态实现](https://github.com/vercel-labs/agent-browser/blob/v0.38.1/cli/src/native/state.rs)，继续保持版本固定，不随文档最新版本自动升级。

## 运维维护

配对码有效十分钟。在窗口内，原安装身份和原配对码可取回同一凭据以恢复丢失回执。撤销的节点不能靠旧码复活；过期回执需要管理员重新安排轮换。恢复凭据的派生依赖 API 管理密钥，窗口内更换该密钥会使原码恢复失败。

轮换在 Console 的空闲节点上签发；未确认关闭的会话会阻止轮换。轮换码有效期间暂停该节点新调度。停止节点，再运行原 pair 命令加 `--replace-credential`，成功后启动服务。新凭据启用后旧凭据失效；原安装身份、SQLite 和会话记录保留。不要删除 home 来绕过恢复或轮换。

API 保留策略需停止 API 后执行，使用原数据库和原证据目录：

```sh
pnpm maintenance:api --days=30
pnpm maintenance:api --days=30 --apply
```

每次最多 100 个终态且会话确认关闭的任务，可重复运行。保留任务定义、报告结论、身份与去重摘要；删除过期证据和命令页面/输入内容，任务详情标明归档时间。孤立文件至少经过一天宽限期才清理。API 独占锁阻止维护和服务同时运行；CLI 不包含自动定时删除。

节点停止后执行：

```sh
proofrun-node --config /etc/proofrun/node.toml retain --days 30
proofrun-node --config /etc/proofrun/node.toml retain --days 30 --apply
proofrun-node --config /etc/proofrun/node.toml recover-reboot
```

retain 只清理 CLOSED 且 outbox 已确认、截图上传已确认的会话目录；登录状态不自动清理，命令/会话身份墓碑不删除。recover-reboot 只处理 boot ID 确实变化、旧随机 unit 非活动的会话，不提供同一启动周期的强制解锁；未知命令恢复为 UNKNOWN 并回报，绝不重放。

## 真实环境验收入口

部署配置好模型的 worker 和实际内网节点后，由上层提交真实任务文件：

```sh
PROOFRUN_CONTROL_URL=https://proofrun.example.com \
PROOFRUN_ADMIN_TOKEN='<从本机配置注入>' \
pnpm accept:task /private/verification-task.json
```

脚本提交原任务、等待执行和关闭、逐项下载报告引用证据并核实 SHA-256，输出到 `.proofrun/acceptance/<taskId>`。没有默认模型或模型密钥，不会生成验收标准，不会自动换任务 ID 重试。可用 `PROOFRUN_ACCEPTANCE_OUTPUT` 指定输出目录。

尚需真实环境完成：模型质量与耗时/token 评估、内网代理和 TLS、业务写入后响应丢失、VM 重启/断电与磁盘故障、长时间并发和容量观测。Node 写动作仍默认关闭，doctor 的 productionReady 与 engineWritesVerified 仍为 false。

用户体系、SSO、多租户按当前产品方向不引入。API 主备、closed Shadow DOM、iframe 条件等待和 Chromium TRACE 已扩展，使用方法与验证边界见 [浏览器能力与高可用](browser-capabilities-ha.md)。这不代表旧平台的所有功能均已迁移。

## 本轮验证结果

协议测试 9 个、Agent 执行场景 19 个、Console 客户端测试 4 个、Rust 测试 13 个；另有真实 PostgreSQL 的 API 集成 14 个场景、Agent/API 集成 7 个场景。Linux 真实 Chromium/systemd 链路完成普通页面及两层 open Shadow DOM 提交，14 份证据摘要匹配并确认关闭。macOS 和 Linux 均验证跨会话登录快照恢复及网络元数据采集。

Console 通过临时数据库验证人工观察、按键、预算计数和恢复；验收导出脚本对既有夹具任务完成幂等提交、终态/关闭检查、报告与证据下载。该导出检查不调用真实模型，不增加真实业务验收结论。详细范围分别见 Agent、控制面、Browser Node 和 Console 验证记录。

## 2026-09-26：HITL 产品流程补充

此前的“人工介入”仅指管理员面板和控制权交接，不包含独立处理页。现已迁移为任务专属免登录页面、节点主动连接的实时画面中转、鼠标键盘输入和完成后关闭处理 tab；原浏览器会话交还 Agent。实现、使用和实际验证范围以 [HITL 说明](hitl.md) 为准。
