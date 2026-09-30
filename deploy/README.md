# 部署

此目录提供 PostgreSQL Compose、节点 TOML、API/Agent/Node 的 systemd 用户服务和 Caddy 同源代理模板。Browser Node 已提供[发布包安装器](../scripts/node-release/README.md)；整套自托管服务仍按模板配置，模板尚未经过真实内网 VM 验收。

在 `pnpm build` 后运行 `pnpm test:deploy` 可通过临时 Docker 容器检查编译产物、两份 Caddy 模板的 `/v1/*`、`/v2/*`、健康检查及 Console 路由，并验证空库迁移和 API 重启持久化。此检查使用 HTTP，不替代目标 VM 的 HTTPS、systemd 和跨主机 HA 验收。

首次交付、版本追溯、业务验收和备份恢复演练见下文版本交付、业务验收和恢复演练章节；CI 的容器回归不代替目标 VM 的部署验收。

目标部署单元：

- 控制面：API、数据库、队列协调、证据对象存储。
- 验证执行 Agent：独立 worker，由模型配置和吞吐需求决定副本。
- Console：静态资源。
- Browser Node：部署在可访问业务环境的 VM，主动连接控制面，运行 Chrome 和 agent-browser。

已完成 systemd 容器内的控制面与节点闭环，真实 Linux 内网 VM 仍需验收，再固化生产镜像与运维流程。不从旧项目直接复制带历史假设的部署脚本。

节点准备：以独立普通用户运行；管理员为该用户启用 linger，创建其可写的 `/var/lib/proofrun`；将固定版本的原生 agent-browser、proofrun-node 与 Chrome 安装到配置指定位置。将 node.example.toml 调整后放到 `/etc/proofrun/node.toml`，凭据保存在节点 home 下的 credential.json（0600）。

将 proofrun-node.service 安装到运行用户的 `~/.config/systemd/user/`，在该用户的 systemd 会话中执行：

```sh
systemctl --user daemon-reload
systemctl --user enable --now proofrun-node.service
journalctl --user -u proofrun-node.service -f
```

apps/api 已提供 `/v1/nodes/connect` 网关与 `/v1/artifacts` 上传服务，控制面启动和节点配对见 [API 说明](../apps/api/README.md)。API 当前只允许一个活动实例；PostgreSQL 与截图目录均需持久化。测试容器与启动脚本位于 tests/browser-node；其 privileged 权限仅用于容器内部 systemd/cgroup 演练，不是生产部署建议。

## 控制面与执行 Agent

在 `/opt/proofrun` 安装锁定依赖并执行 `pnpm build`。API 与 Agent 的用户服务分别读取 `/etc/proofrun/api.env` 和 `/etc/proofrun/agent.env`，变量以根目录 `.env.example` 为准；文件仅运行用户可读。运行用户需要持久证据目录和数据库权限；worker 只需连接控制面与模型服务。模型地址、型号与密钥没有默认值。

复制相应 service 到运行用户的 `~/.config/systemd/user/`，执行 `systemctl --user daemon-reload` 和 `systemctl --user enable --now proofrun-api.service proofrun-agent.service`。生产环境按实际 Node.js 24 安装位置调整 ExecStart。Caddyfile 中的 PROOFRUN_DOMAIN 由服务环境提供；静态 Console 与 `/v1/*`、`/v2/*` 在同一个 HTTPS origin，节点使用同源 WSS，无需反向访问内网。

备份范围为 PostgreSQL、API 证据目录、节点 home（含身份、SQLite、凭据与登录状态）；数据库和证据应在停止写入后一起备份，恢复到同一版本。维护默认只预览；配对回执恢复、轮换、清理和重启处理见 [部署与运行维护](README.md)。不要用测试容器的 privileged 配置作为生产部署方式。

## 节点轮换与停机维护

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

## 真实任务验收

部署配置好模型的 worker 和实际内网节点后，由上层提交真实任务文件：

```sh
PROOFRUN_CONTROL_URL=https://proofrun.example.com \
PROOFRUN_ADMIN_TOKEN='<从本机配置注入>' \
pnpm accept:task /private/verification-task.json
```

脚本提交原任务、等待执行和关闭、逐项下载报告引用证据并核实 SHA-256，输出到 `.proofrun/acceptance/<taskId>`。没有默认模型或模型密钥，不会生成验收标准，不会自动换任务 ID 重试。可用 `PROOFRUN_ACCEPTANCE_OUTPUT` 指定输出目录。

尚需真实环境完成：模型质量与耗时/token 评估、内网代理和 TLS、业务写入后响应丢失、VM 重启/断电与磁盘故障、长时间并发和容量观测。Node 写动作仍默认关闭，doctor 的 productionReady 与 engineWritesVerified 仍为 false。

用户体系、SSO、多租户按当前产品方向不引入。API 主备、closed Shadow DOM、iframe 条件等待和 Chromium TRACE 已扩展，使用方法与验证边界见 [浏览器能力与高可用](../docs/browser-capabilities-ha.md)。

## 版本与交付

- 为拟发布源码建立 Git 提交，确认没有未纳入版本的必要文件；本机凭据、登录态和证据目录继续排除。
- 在该提交上完成检查，再创建明确的 Alpha 标签；保留提交 ID、构建环境、引擎版本、依赖锁文件和检查日志。
- 从干净检出重新安装和构建，按照部署文档启动；迁移 SQL 必须与 API 一起交付。
- 更新 CHANGELOG 的版本、日期、兼容范围和已知限制；只在真实发布后将条目移出“未发布”。
- 开源前由项目维护者确定许可证及第三方分发要求。`private: true` 与 Cargo 的 `publish = false` 保持不变。

## 业务验收

验收材料必须绑定源码提交、实际部署二进制摘要、模型名称与配置。逐个记录输入、原始证据、独立检查结果、总耗时和供应商 token 用量，保留失败与阻塞样本。

- 将每个必验结果列成单独验收项。结构化业务步骤可使用 Case API v2 的 check 步骤与 expected；不要用一条“下拉包含选项”代表所有弹窗、默认开关和清理要求均通过。
- 固定代表性场景及重复次数，分别报告通过、误报、漏报、阻塞与故障，记录耗时分布。先确定业务可接受门槛，再执行，不能只保留成功轨迹。
- 初次登录、登录过期、人工介入、虚拟列表、跨 frame、取消、超时和未知写入均须有对应场景。
- PASSED 必须有对应业务真值复核；COMPLETED、模型的步骤完成声明和证据摘要匹配均不能单独证明业务结论正确。
- 写操作的“业务已成功但引擎响应丢失”需要真实引擎故障注入和服务端独立计数。未完成前保留默认关闭与 `engineWritesVerified: false`，不通过修改布尔值宣布验收完成。

## 部署与恢复演练

在目标 Linux VM 使用普通运行用户，记录每项实际命令、预期和结果：

1. 干净安装并通过同源 HTTPS/WSS 连通性、配对、任务、证据下载和会话关闭检查。
2. 运行预先定义的并发与持续负载，观察队列等待、任务延迟、磁盘增长和关闭后残留进程。
3. 重启 API、Agent、节点及 VM；核对持久任务、未知效果、租约与容量。未知写入不得因恢复而重放。
4. 停止全部 API/Agent/Node 写入，成套备份 PostgreSQL、API 证据和节点 home；在隔离目标恢复到同一版本，核对历史报告、证据摘要、身份及登录快照权限。
5. 演练磁盘满、数据库中断和证据存储不可用；HA 部署还须演练实际入口及共享盘故障。
6. 升级前备份并留存原版本。数据库升级后不能仅切换旧二进制作为回滚；按已验证方案恢复同版本数据库、证据和节点状态。

这些项目需要指定 VM、业务环境和维护窗口。容器回归与模板文件不能把它们自动标为完成。
