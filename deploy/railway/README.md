# Railway 部署

Railway 运行 API、Web Console、执行 Agent 和 PostgreSQL；访问业务页面的 Browser Node 安装在 Linux 节点机。节点安装与升级见 [节点 release](../../scripts/node-release/README.md)。

## 服务与配置文件

在同一 Railway 项目和环境中添加 PostgreSQL，然后从同一个 GitHub 仓库创建三个服务。**三个服务的 Root Directory 均保持仓库根目录**，通过服务设置或 `RAILWAY_DOCKERFILE_PATH` 指定下表的 Dockerfile。清空自动识别产生的 Build Command 和 Start Command，使用镜像内的构建步骤和启动命令。不要把 Root Directory 改成 apps 子目录，否则 workspace 契约及锁文件不可见；`contracts` 是共享代码包，不创建独立服务。

通过 GraphQL 更新服务时，传 `null` 不一定清除已有命令。Build Command 可设为空字符串；Start Command 可显式设置为 API 的 `node railway-entry.mjs`、Web 的 `caddy run --config /etc/caddy/Caddyfile --adapter caddyfile`、Agent 的 `node dist/main.js serve`。部署后应检查实际 deployment manifest，不能只依据更新接口返回成功判断旧配置已经清除。

| 服务名     | Dockerfile 路径                   | 公开入口                              | 持久化                     |
| ---------- | --------------------------------- | ------------------------------------- | -------------------------- |
| `api`      | `deploy/railway/Dockerfile.api`   | 不创建公开域名                        | 必须挂载 Volume 到 `/data` |
| `web`      | `deploy/railway/Dockerfile.web`   | 创建 Railway HTTPS 域名或绑定自有域名 | 不需要 Volume              |
| `agent`    | `deploy/railway/Dockerfile.agent` | 不创建公开域名                        | 无状态，不需要 Volume      |
| `Postgres` | Railway PostgreSQL 服务           | 应用使用私网连接                      | 数据库自己的 Volume        |

Railway 当前已弃用旧 Config as Code，设置 `railwayConfigFile` 可能直接被 API 拒绝；不要继续把 `api.json` 等文件路径当作已生效的部署设置。本目录 JSON 保留为参数参考，新的声明式管理入口见 [Railway IaC](https://docs.railway.com/infrastructure-as-code)。直接配置服务时，三个应用均设单副本、关闭休眠、失败重启最多 10 次、停止宽限 30 秒；API 和 Web 的健康检查均为 `/health/ready`，超时 120 秒，Agent 不配置 HTTP 健康检查。API 的部署重叠时间设为 0。

必须实际创建 PostgreSQL 和 API Volume，并确认 API Volume 已挂载 `/data`；旧 JSON 中的 `requiredMountPath` 在未使用该配置时不提供挂载保护。API 只运行一个副本；持有数据库独占锁的旧实例必须退出后新实例才能启动，带 Volume 的服务升级存在短暂停机。三个应用的 **Watch Paths 保持为空**（API 表示为 `watchPatterns: []`），关闭文件路径过滤，让跟踪分支的每次更新都进入部署流程，覆盖共享契约、锁文件及部署目录。代价是仅文档修改也会触发三个应用部署。不要配置 `/**` 作为本项目的全量监听：现有部署曾在该配置下以 `No changes to watched files` 跳过实际代码变更。这个观察不代表所有 Railway 项目中的同一模式都无效。

## 修复已有服务的部署跳过

`api.json`、`web.json`、`agent.json` 中显式记录空的 `build.watchPatterns`，但这些参考文件不会自动覆盖 Railway 中独立保存的设置。**合并仓库修改或仅修改 JSON 不会解除现有过滤**，需要对目标环境执行一次配置修复。

安装并登录 Railway CLI 后，从仓库根目录运行下列命令。`--project` 必须填写项目 ID，`--environment` 可填写环境名称或 ID，不依赖本地 link 状态。

```sh
# 只读预览三个应用当前的 Watch Paths 与拟议变更。
node scripts/railway-watch-paths.mjs --project PROJECT_ID --environment production

# 只把对应环境中 api、web、agent 的 Watch Paths 清空变更暂存到 Railway。
node scripts/railway-watch-paths.mjs --project PROJECT_ID --environment production --stage
```

脚本通过 Railway CLI 查询实时服务设置，仅输出项目、环境和监听规则；三个应用必须全部存在才允许暂存。`--stage` 不发布部署，不提交环境中已有的待发布变更，也不修改数据库、变量、挂载卷、Dockerfile、跟踪分支或 Wait for CI 设置。目标服务使用其他名称时应先调整脚本中的应用列表。

在 Railway 页面审阅暂存变更，确认三个应用的 Watch Paths 均为空，按下文升级流程等待活动任务结束并完成备份，再发布配置并部署最新 `main`。不要仅重启旧实例，或把旧成功部署的 Redeploy 当作拉取最新代码。已被标记为 `SKIPPED` 的历史提交不会因清空配置就自动变为已上线。

部署后再次运行只读预览，确认 `before` 均为空，并检查实际运行版本：

```sh
railway deployment list --project PROJECT_ID --environment production --service api --limit 5 --json
railway deployment list --project PROJECT_ID --environment production --service web --limit 5 --json
railway deployment list --project PROJECT_ID --environment production --service agent --limit 5 --json
railway status --project PROJECT_ID --environment production --json
```

核对各服务 `activeDeployments` 的 `meta.commitHash` 是否为目标提交；部署列表用于查看最近部署的 `status` 和 `meta.skippedReason`，不能仅凭 `latestDeployment` 推断最新 GitHub 提交已运行。最后检查公开 `/health/ready`、Console 新版文案和所需业务功能。

回归命令 `node --test tests/railway/watch-paths.test.mjs` 使用 CLI 响应夹具验证环境选择、只读预览和暂存边界；不模拟 Railway 的路径匹配器，也不证明线上部署已完成。Watch Paths 的平台语义见 [Railway 构建配置](https://docs.railway.com/builds/build-configuration#configure-watch-paths)。

## 首次变量配置

先为 Web 分配公开域名，再配置下面的变量。表内 `${{...}}` 为 Railway 引用变量，服务名称必须与项目中实际名称一致。

API：

| 变量                         | 值                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `PORT`                       | `4100`，使私网上游端口固定                                                                |
| `PROOFRUN_DATABASE_URL`      | `${{Postgres.DATABASE_URL}}`                                                              |
| `PROOFRUN_ADMIN_TOKEN`       | 独立生成的随机密钥，至少 32 字符                                                          |
| `PROOFRUN_WORKER_TOKEN`      | 另一份独立随机密钥，至少 32 字符                                                          |
| `PROOFRUN_PUBLIC_URL`        | Web 的 HTTPS origin，当前生产为 `https://proofrun.ethankit.com`，无路径                   |
| `PROOFRUN_CONSOLE_URL`       | Console 的 HTTPS origin，当前生产为 `https://proofrun.ethankit.com`                       |
| `PROOFRUN_CASE_PROFILE_JSON` | [case-profile.example.json](../case-profile.example.json) 的 JSON，替换环境、节点池与预算 |

密钥可分别使用 `openssl rand -hex 32` 生成。不要把密钥写入仓库、Docker build arguments 或 `VITE_*` 变量。

镜像默认监听 `::`，兼容私网 IPv4/IPv6；证据默认写入 `/data/artifacts`。不要把 `PROOFRUN_PUBLIC_URL` 填成 API 私网地址。`PROOFRUN_CONSOLE_URL` 不设置时沿用公开地址，无需额外 CORS 配置。Case profile 的 JSON 与 `PROOFRUN_CASE_PROFILE_FILE` 不能同时设置；未设置 profile 时不会接受新 case。

Web：

| 变量                    | 值                                     |
| ----------------------- | -------------------------------------- |
| `PROOFRUN_API_UPSTREAM` | `${{api.RAILWAY_PRIVATE_DOMAIN}}:4100` |

Web 的 Caddy 监听 Railway 提供的 `PORT`，TLS 由 Railway 边缘处理。`/v1/*`、`/v2/*`、`/health/*` 及 WebSocket 握手转发到 API，其余路径提供 Console 静态页面。Web 不保存管理员凭据，也不注入前端密钥。

`/docs`、`/docs/*` 和 `/openapi.json` 也转发到 API，提供同源在线文档。当前生产额外为 API 绑定 `api-proofrun.ethankit.com`，供外部服务端调用与文档接入；它不是 Console 的 Origin，不能据此把 `PROOFRUN_PUBLIC_URL` 改成 API 域名。更换 Console 域名后，需同步更新公开地址和 Console 地址并重新部署 API，否则实时画面会因 Origin 不匹配而被拒绝。

Agent：

| 变量                         | 值                                                        |
| ---------------------------- | --------------------------------------------------------- |
| `PROOFRUN_CONTROL_URL`       | `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:4100`             |
| `PROOFRUN_WORKER_TOKEN`      | `${{api.PROOFRUN_WORKER_TOKEN}}`                          |
| `PROOFRUN_MODEL_BASE_URL`    | 实际 Chat Completions 服务根地址，例如供应商的 `/v1` 地址 |
| `PROOFRUN_MODEL_API_KEY`     | 模型服务密钥                                              |
| `PROOFRUN_MODEL`             | 实际模型名称                                              |
| `PROOFRUN_MODEL_VISION`      | 模型支持视觉时设为 `true`，否则 `false`                   |
| `PROOFRUN_AGENT_CONCURRENCY` | 初始可设为 `2`，同时确认节点容量和供应商配额              |

Agent 是后台 worker，启动命令包含 `serve`，不提供 HTTP 健康端点。若使用 JEV 执行模式，再配置 `TYPESAFE_API_KEY` / `TYPESAFE_MODEL`；普通模型模式不需要它们。其它可选参数见根目录 [.env.example](../../.env.example)。

## 发布、检查与升级

1. 挂载 API Volume 并配置数据库、密钥和公开 origin，再部署 API。数据库迁移由 API 启动执行，不要额外配置并发迁移任务。
2. 部署 Web，检查公开 `/health/ready` 返回就绪 JSON、Console 可打开、未授权的 `/v2/cases/...` 返回 401 JSON。
3. 配置并部署 Agent，从 Console 注册节点池和一次性配对码，再在 Linux 机器安装 Browser Node。
4. 运行真实测试任务，确认节点在线、报告、证据下载及人工介入均使用 Web 的同一 HTTPS origin。

后续通过 GitHub 分支更新触发 Railway 部署，不在 Railway 容器运行节点安装脚本。启用 Railway 的 Wait for CI，避免 CI 未通过的提交直接部署。升级前等待活动任务结束并备份 PostgreSQL 和 `/data`；有数据库迁移时不能仅切回旧镜像来代替数据恢复。Browser Node 登录态和本地 SQLite 需在节点机另行备份。

本地镜像回归：

```sh
docker build -f deploy/railway/Dockerfile.api -t proofrun-railway-api:test .
docker build -f deploy/railway/Dockerfile.web -t proofrun-railway-web:test .
docker build -f deploy/railway/Dockerfile.agent -t proofrun-railway-agent:test .
node --test tests/railway/smoke.test.mjs
```

回归使用独立临时数据库，验证编译产物、profile 变量、PORT、API 鉴权、WebSocket 升级、worker 领取协议和持久卷重建；不调用真实模型或业务浏览器，也不证明 Railway 项目中的域名、权限、容量和备份已经验收。

配置依据：[Railway Dockerfile](https://docs.railway.com/builds/dockerfiles)、[配置文件](https://docs.railway.com/config-as-code/reference)、[健康检查](https://docs.railway.com/deployments/healthchecks)、[持久卷](https://docs.railway.com/volumes)。
