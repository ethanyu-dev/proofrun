# Railway 部署

Railway 运行 API、Web Console、执行 Agent 和 PostgreSQL；访问业务页面的 Browser Node 安装在 Linux 节点机。节点安装与升级见 [节点 release](../../scripts/node-release/README.md)。

## 发布入口与真实报告传递

使用 `Release Railway` 工作流发布：仅在当前 `main` 的完整 CI 成功后启动，从同一次 CI 下载 `real-agent-benchmark-release`。发布脚本核对提交、CI 尝试号、24 小时有效期和源码指纹，再生成包含 Git 源码、真实报告与独立 `.benchmark-release/build-info.json` 版本清单的干净上传目录。API、Agent、Web 都使用该目录构建；Docker 只带入版本清单，不读取真实报告。

**常规代码发布仍使用 `Release Railway`，建议关闭 Railway 的 Git 自动部署，避免重复发布。** 修改配置后允许 Railway 直接从 Git 构建，不要求真实报告；此入口不执行报告校验。真实基准及报告来源、有效期、源码指纹检查保留在 CI 和正式发布脚本中，不要把报告提交到 Git。下文 Watch Paths 设置只涉及路径过滤。

GitHub 配置 `PROOFRUN_RAILWAY_TOKEN` Secret（仅目标项目及生产环境范围），以及 `PROOFRUN_RAILWAY_PROJECT_ID`、`PROOFRUN_RAILWAY_ENVIRONMENT_ID` Variables。工作流不会将模型密钥或管理员凭据写入源码包；管理员凭据仅在发布进程内从指定环境读取，用于检查活动任务和实际 API 版本。

发布独立串行运行，不被下一次 CI 推送取消。升级前要求队列与运行任务为空，并确认 API 和 PostgreSQL 卷备份；按 API、Agent、Web 顺序等待每个部署成功，API/Web 另核对实际构建版本。任何阶段失败立即停止后续服务，保留失败部署 ID。数据库迁移自身的活动资源保护也保持启用，不能自动取消任务来绕过。

失败后可手动运行 `Release Railway`，填写同一成功 CI 的 `ci_run_id`；若报告已过期或 main 已更新，需要对应提交重新完成 CI。也可在该提交的干净 checkout 中使用已登录的 CLI：

```bash
pnpm install --frozen-lockfile
pnpm --filter @proofrun/contracts build
# 只生成并校验发布目录，不访问生产变量、备份或部署。
node scripts/railway-release.mjs --repository OWNER/REPO --run CI_RUN_ID --project PROJECT_ID --environment ENVIRONMENT_ID --prepare-only
# 去掉 --prepare-only 后完成备份与三个服务的顺序发布。
```

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

| 变量                           | 值                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `PORT`                         | `4100`，使私网上游端口固定                                                                |
| `PROOFRUN_DATABASE_URL`        | `${{Postgres.DATABASE_URL}}`                                                              |
| `PROOFRUN_ADMIN_TOKEN`         | 独立生成的随机密钥，至少 32 字符                                                          |
| `PROOFRUN_WORKER_TOKEN`        | 另一份独立随机密钥，至少 32 字符                                                          |
| `PROOFRUN_PUBLIC_URL`          | Web 的 HTTPS origin，当前生产为 `https://proofrun.ethankit.com`，无路径                   |
| `PROOFRUN_CONSOLE_URL`         | Console 的 HTTPS origin，当前生产为 `https://proofrun.ethankit.com`                       |
| `PROOFRUN_CASE_PROFILE_JSON`   | [case-profile.example.json](../case-profile.example.json) 的 JSON，替换环境、节点池与预算 |
| `PROOFRUN_CASE_EXECUTION_MODE` | 可选；默认且仅支持 `llm`                                                                  |

密钥可分别使用 `openssl rand -hex 32` 生成。不要把密钥写入仓库、Docker build arguments 或 `VITE_*` 变量。

从含 v3 的版本升级时，先按 [v3 退役升级](../../apps/api/README.md#v3-退役升级) 结束 external 运行并回收资源；API 会在仍有活动资源时拒绝迁移。

需要飞书群通知时，仅在 API 增加 `PROOFRUN_FEISHU_APP_ID`、`PROOFRUN_FEISHU_APP_SECRET` 和 `PROOFRUN_FEISHU_CHAT_ID`，三个变量同时填写。使用已发布的企业自建应用机器人并将其加入目标群，权限与卡片同步规则见 [Case 飞书生命周期通知](../../apps/api/README.md#case-飞书生命周期通知)。

镜像默认监听 `::`，兼容私网 IPv4/IPv6；证据默认写入 `/data/artifacts`。不要把 `PROOFRUN_PUBLIC_URL` 填成 API 私网地址。`PROOFRUN_CONSOLE_URL` 不设置时沿用公开地址，无需额外 CORS 配置。Case profile 的 JSON 与 `PROOFRUN_CASE_PROFILE_FILE` 不能同时设置；未设置 profile 时不会接受新 case。

Railway 新 case 只支持 llm，未配置时默认 llm。启动脚本对 JSON 或文件来源生成私有临时副本，保留环境、预算和取证配置，不修改原文件。独立变量或 profile 显式要求 jev/parallel 时拒绝启动，须先完成配置迁移；两种配置来源同时存在也拒绝启动。

正常单 LLM 任务保持冻结定义；迁移 043 删除 JEV/双跑历史运行及关联记录，升级前须结束这些运行并确认浏览器关闭。平台变量需显式更新并重新部署；本地修改不代表线上已经切换。

`node --test tests/railway/api-entry.test.mjs` 检查 llm 默认值、配置来源及旧模式拒绝，不证明线上部署状态。

Web：

| 变量                    | 值                                     |
| ----------------------- | -------------------------------------- |
| `PROOFRUN_API_UPSTREAM` | `${{api.RAILWAY_PRIVATE_DOMAIN}}:4100` |

Web 的 Caddy 监听 Railway 提供的 `PORT`，TLS 由 Railway 边缘处理。`/v1/*`、`/v2/*`、`/health/*` 及 WebSocket 握手转发到 API，其余路径提供 Console 静态页面。Web 不保存管理员凭据，也不注入前端密钥。

### 真实客户端 IP

当前生产两个自定义域名均经过 Cloudflare：控制台链路为 Cloudflare → Railway → Web Caddy → API，API 域名链路为 Cloudflare → Railway → API。在 **API 服务**设置 `PROOFRUN_TRUSTED_PROXIES=railway` 和 `PROOFRUN_TRUSTED_CDN=cloudflare`；Web 保留上游 `X-Real-IP` 和 `CF-Connecting-IP`，无需把 Caddy 重建的 `X-Forwarded-For` 当成原始客户端地址。

[Railway 网络规范](https://docs.railway.com/networking/public-networking/specs-and-limits) 指定 `X-Real-IP` 表示边缘连接的客户端，[官方支持确认](https://station.railway.com/questions/supported-client-ip-trust-boundary-for-f-0e4c52d9) 边缘会覆盖客户端提交的同名头，但没有稳定的边缘 IP 网段；同环境私网请求不经过该重写。因此仅在私网服务均可信且 API/Web 未开放 TCP Proxy 时启用此模式，不能复制到任意自建 HTTP 服务。

API 先读取 Railway 重写的地址，再检查其是否命中 [Cloudflare 官方网段](https://www.cloudflare.com/ips/)，命中后才使用 [CF-Connecting-IP](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip)。直连 Railway 域名的访客即使伪造 Cloudflare 头也不会命中此信任条件。缺失、非法或多值来源头回退到上一跳，不选取任意列表元素。此方案仅用于审计，不能作为登录或权限依据。

更新变量时使用 `railway variable set ... --skip-deploys`，随通过 CI 的代码一起发布，避免提前重启旧版本。发布后分别通过两个自定义域名和 Railway 原生域名发送登录及 HTTP 请求，再从管理员访问记录核对来源、状态，并验证伪造转发头未污染记录。仅看到变量已保存或健康检查成功不表示真实 IP 验证完成。

`/docs`、`/docs/*` 和 `/openapi.json` 也转发到 API，提供同源在线文档。当前生产额外为 API 绑定 `api-proofrun.ethankit.com`，供外部服务端调用与文档接入；它不是 Console 的 Origin，不能据此把 `PROOFRUN_PUBLIC_URL` 改成 API 域名。更换 Console 域名后，需同步更新公开地址和 Console 地址并重新部署 API，否则实时画面会因 Origin 不匹配而被拒绝。

Agent：

| 变量                              | 值                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `PROOFRUN_CONTROL_URL`            | `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:4100`                                     |
| `PROOFRUN_WORKER_TOKEN`           | `${{api.PROOFRUN_WORKER_TOKEN}}`                                                  |
| `PROOFRUN_MODEL_BASE_URL`         | 实际 Chat Completions 服务根地址，例如供应商的 `/v1` 地址                         |
| `PROOFRUN_MODEL_API_KEY`          | 模型服务密钥                                                                      |
| `PROOFRUN_MODEL`                  | 实际模型名称                                                                      |
| `PROOFRUN_MODEL_VISION`           | 模型支持视觉时设为 `true`，否则 `false`                                           |
| `PROOFRUN_MODEL_THINKING`         | 默认 `default`；DeepSeek 显式选择 `enabled` 或 `disabled`                         |
| `PROOFRUN_MODEL_REASONING_EFFORT` | 默认 `default`；可设 `low` / `high` / `max`，显式关闭思考优先于档位               |
| `PROOFRUN_AGENT_EVIDENCE_MS`      | 可选，默认 `60000`；观察和 TRACE 完成后等待证据上传及可用确认，仍受任务总期限约束 |

Agent 是后台 worker，启动命令包含 `serve`，不提供 HTTP 健康端点。Agent 持续领取，执行并发由节点资源准入决定；旧 `PROOFRUN_AGENT_CONCURRENCY` 已不再读取，升级后即使保留 `2` 也不会继续限流，可从服务变量删除。节点可接收更多任务时，模型并发请求也会增加，应核对供应商配额。只配置上述 LLM；TYPESAFE、JEV 与旧执行策略变量不再使用。其它参数见根目录 [.env.example](../../.env.example)。升级 API、Agent、Node 后，新调度要求节点声明 ephemeralProfiles。

切换到 DeepSeek 时，按 [Agent 配置说明](../../apps/agent/README.md) 设置 `PROOFRUN_MODEL_THINKING=enabled`、`PROOFRUN_MODEL_REASONING_EFFORT=high` 与 `PROOFRUN_MODEL_MAX_TOKENS=8192`，直连官方接口使用 `PROOFRUN_MODEL_TOKEN_PARAMETER=max_tokens`。先部署支持推理参数的 Agent 与 API 版本，再确认变量变更已部署；原来已失败的任务需要另行重试，更新配置不会改变历史报告。输出上限包含推理 token，复杂调用仍可能截断，不能将提高上限视为增加步骤时间。

## 发布、检查与升级

1. 挂载 API Volume 并配置数据库、密钥和公开 origin，再部署 API。数据库迁移由 API 启动执行，不要额外配置并发迁移任务。
2. 部署 Web，检查公开 `/health/ready` 返回就绪 JSON、Console 可打开、未授权的 `/v2/cases/...` 返回 401 JSON。
3. 配置并部署 Agent，从 Console 注册节点池和一次性配对码，再在 Linux 机器安装 Browser Node。
4. 运行真实测试任务，确认节点在线，报告与证据通过 Web 访问，人工操作与实时画面直连 Node 的 HTTPS 域名。显式多控制面绑定还需在 Node 本机批准此环境的 Console Origin。

正式 CI 发布前必须在当前源码运行真实模型 + Chrome 基准，发布脚本会核实完整套件、24 小时有效期及源码指纹。Docker 构建不读取报告，允许直接从 Git 重建以应用配置变更；这类直接部署不代表真实基准已通过。模型密钥不进入构建上下文，配置见 [真实基准说明](../../scripts/benchmarks/README.md)。不在 Railway 容器运行节点安装脚本。启用 Railway 的 Wait for CI，避免 CI 未通过的提交直接部署。升级前等待活动任务结束并备份 PostgreSQL 和 `/data`；有数据库迁移时不能仅切回旧镜像来代替数据恢复。Browser Node 登录态和本地 SQLite 需在节点机另行备份。

本地镜像回归：

```sh
docker build -f deploy/railway/Dockerfile.api -t proofrun-railway-api:test .
docker build -f deploy/railway/Dockerfile.web -t proofrun-railway-web:test .
docker build -f deploy/railway/Dockerfile.agent -t proofrun-railway-agent:test .
node --test tests/railway/smoke.test.mjs
```

镜像 smoke 回归使用独立临时数据库，验证编译产物、profile 变量、PORT、API 鉴权、WebSocket 升级、worker 领取协议和持久卷重建；不调用真实模型或业务浏览器，也不证明 Railway 项目中的域名、权限、容量和备份已经验收。

配置依据：[Railway Dockerfile](https://docs.railway.com/builds/dockerfiles)、[配置文件](https://docs.railway.com/config-as-code/reference)、[健康检查](https://docs.railway.com/deployments/healthchecks)、[持久卷](https://docs.railway.com/volumes)。

## 部署版本与线上 Benchmark

API、Agent、Web 最终镜像始终生成 `build-info.json`。CI 发布脚本先校验真实报告，再提取独立版本清单，保留发布版本和 CI 构建编号；镜像核对清单的源码指纹。Railway 直接构建通过 Docker `ARG RAILWAY_GIT_COMMIT_SHA` 记录完整提交，使用 `git-<短 SHA>` 版本和 `source-<源码指纹>` 构建身份，无需报告。版本清单只标识源码，不证明基准通过。

本地构建可传 `--build-arg RAILWAY_GIT_COMMIT_SHA="$(git rev-parse HEAD)"`；未提供提交时仍生成带源码指纹的 development 清单，不能发起线上基准。API/Agent 读取各自镜像内的 `dist/build-info.json`，Web 提供 `/build-info.json`；运行时变量不能覆盖已嵌入的身份。正式发布通过真实基准工作流的 `release_version` 指定版本，三个镜像使用同一份 CI 版本清单。构建参数声明遵循 [Railway Dockerfile 变量规则](https://docs.railway.com/builds/dockerfiles#using-variables-at-build-time)。

API 增加 `PROOFRUN_BENCHMARK_NODE_POOL`（已配对的基准节点池）与 `PROOFRUN_BENCHMARK_ENVIRONMENT`（如 staging / production）。同时升级 API 和 Agent，数据库启动时应用迁移 044。节点需能访问公开 API 的合成页面；建议为基准使用独立节点池，以免与业务任务竞争资源。模型仍使用 Agent 的现有配置，管理员网页不接触密钥。

Console 连接后进入 Benchmark → 线上调度与存储 → 发起线上基准。后台自动调度固定七场景基础验证并保存逐轮记录，归档包含入队发布身份与实际 API、Agent、Node 身份；组件版本不匹配、模型记录不全或未核实会话关闭均判为失败。线上结果作为部署后检查，本地/CI 的发布前门禁仍然必需。数据库记录需随 PostgreSQL 一起备份；目前不自动清除基准归档。

发布门禁只要求当前源码的完整基础验证通过；V2 真实任务是独立诊断，不因其失败或未运行阻断发布。运行中的生产任务仍保留升级前安全收尾要求。
