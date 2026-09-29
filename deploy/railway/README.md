# Railway 部署

Railway 运行 API、Web Console、执行 Agent 和 PostgreSQL；访问业务页面的 Browser Node 安装在 Linux 节点机。节点安装与升级见 [节点 release](../../scripts/node-release/README.md)。

## 服务与配置文件

在同一 Railway 项目和环境中添加 PostgreSQL，然后从同一个 GitHub 仓库创建三个服务。**三个服务的 Root Directory 均保持仓库根目录**，在各自 Settings 中指定对应的 Config File 路径。不要把 Root Directory 改成 apps 子目录，否则 workspace 契约及锁文件不可见。

| 服务名     | Config File                  | 公开入口                              | 持久化                     |
| ---------- | ---------------------------- | ------------------------------------- | -------------------------- |
| `api`      | `/deploy/railway/api.json`   | 不创建公开域名                        | 必须挂载 Volume 到 `/data` |
| `web`      | `/deploy/railway/web.json`   | 创建 Railway HTTPS 域名或绑定自有域名 | 不需要 Volume              |
| `agent`    | `/deploy/railway/agent.json` | 不创建公开域名                        | 无状态，不需要 Volume      |
| `Postgres` | Railway PostgreSQL 服务      | 应用使用私网连接                      | 数据库自己的 Volume        |

JSON 配置定义 Dockerfile、重启策略、单副本和健康检查，但不会自动创建这些服务、数据库、域名、变量或 Volume。API 的 `requiredMountPath` 要求挂载 `/data`，防止把证据写到随重部署丢失的临时文件系统。API 只运行一个副本；持有数据库独占锁的旧实例必须退出后新实例才能启动，带 Volume 的服务升级存在短暂停机。

## 首次变量配置

先为 Web 分配公开域名，再配置下面的变量。表内 `${{...}}` 为 Railway 引用变量，服务名称必须与项目中实际名称一致。

API：

| 变量                         | 值                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `PORT`                       | `4100`，使私网上游端口固定                                                                |
| `PROOFRUN_DATABASE_URL`      | `${{Postgres.DATABASE_URL}}`                                                              |
| `PROOFRUN_ADMIN_TOKEN`       | 独立生成的随机密钥，至少 32 字符                                                          |
| `PROOFRUN_WORKER_TOKEN`      | 另一份独立随机密钥，至少 32 字符                                                          |
| `PROOFRUN_PUBLIC_URL`        | Web 的 HTTPS origin，例如 `https://proofrun.example.com`，无路径                          |
| `PROOFRUN_CASE_PROFILE_JSON` | [case-profile.example.json](../case-profile.example.json) 的 JSON，替换环境、节点池与预算 |

密钥可分别使用 `openssl rand -hex 32` 生成。不要把密钥写入仓库、Docker build arguments 或 `VITE_*` 变量。

镜像默认监听 `::`，兼容私网 IPv4/IPv6；证据默认写入 `/data/artifacts`。不要把 `PROOFRUN_PUBLIC_URL` 填成 API 私网地址。`PROOFRUN_CONSOLE_URL` 不设置时沿用公开地址，无需额外 CORS 配置。Case profile 的 JSON 与 `PROOFRUN_CASE_PROFILE_FILE` 不能同时设置；未设置 profile 时不会接受新 case。

Web：

| 变量                    | 值                                     |
| ----------------------- | -------------------------------------- |
| `PROOFRUN_API_UPSTREAM` | `${{api.RAILWAY_PRIVATE_DOMAIN}}:4100` |

Web 的 Caddy 监听 Railway 提供的 `PORT`，TLS 由 Railway 边缘处理。`/v1/*`、`/v2/*`、`/health/*` 及 WebSocket 握手转发到 API，其余路径提供 Console 静态页面。Web 不保存管理员凭据，也不注入前端密钥。

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
