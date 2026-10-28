# ProofRun

接收上层 Agent 定义的验证任务，调度内网浏览器节点执行，交付有证据的验收报告。

**Browser Node、最小控制面与执行 Agent 已接通，并通过脚本模型驱动的 Linux 真实浏览器闭环验证。模型服务和型号均可配置，Console 已接入任务、节点查询与证据报告。没有 Spec Runtime，也没有需求分析、Spec 生成或验收标准生成流程。** 上层 Agent 负责这些定义；ProofRun 负责输入校验、实际环境预检、执行与报告。

**结构化任务接入：[Case API v2](docs/public-api-v2.md) · [批量示例](contracts/examples/public-api/cases-v2.json)。每个对象对应独立任务，内部按 exec_order 串行执行，业务清理在原会话末尾执行，独立预算三分钟。**

**请求归属与汇总：** v2 支持 `{ requestId, title, cases }` 封装，同次提交在任务和报告中按请求展示；双跑按唯一验收项统计，支持部分报告、组间差异、JSON 导出和整请求原子重跑。旧数组提交保留在未归组任务中。见 [请求示例](contracts/examples/public-api/request-v2.json) 与 [设计](docs/verification-request-design.md)。

**账号来源：仅支持 [DevPass 外部账号](apps/api/src/modules/account-providers/README.md)，以及访客和当前会话人工登录。不再维护本地账号库、自动选账号或节点登录配方。**

**原单 case 接入：[Case API](docs/public-api.md) · [OpenAPI](contracts/public-api.openapi.json) · [case 示例](contracts/examples/public-api/case.json)。** 调用方提交任务描述、待测 URL、可选步骤和验收项；环境、身份与预算由[平台配置](docs/case-platform-config.md)提供。

## 项目结构

```text
apps/
  api/                 控制面：任务、节点、队列、租约、证据与报告
  agent/               内置模型 Worker：领取任务、续租并提交模型决定（保留旧执行兼容路径）
  console/             控制台：任务、节点、证据报告、人工介入
packages/
  execution-core/      共享门禁、账本、上下文、证据与报告规则
  execution-driver/    共享执行编排、观察/动作循环与分组清理
crates/
  browser-node/        Rust 远端节点：主动连接、会话监管、agent-browser 适配
contracts/
  schemas/             JSON Schema 协议源文件
  src/generated/       自动生成的 TypeScript 类型
  src/index.ts         协议校验入口
scripts/               类型生成与工程工具
tests/
  contracts/           输入和报告协议约束
  scenarios/           端到端验收场景与任务样例
docs/
  decisions/           架构决策
  architecture.md      职责、状态归属与数据流
deploy/                部署模板、运行维护和环境验收
```

## 当前状态

发布范围、工程检查与尚需完成的环境验收见 [部署与运行维护](deploy/README.md)，版本变更见 [CHANGELOG](CHANGELOG.md)。

| 组件         | 已实现                                                                 | 待验收或后续扩展                     |
| ------------ | ---------------------------------------------------------------------- | ------------------------------------ |
| Contracts    | 任务、报告、节点、人工控制与活动记录协议；同源类型和校验               | 真实场景驱动的协议完善               |
| API          | 队列、网关、配对/轮换、容量、租约、证据报告、人工控制和维护 CLI        | 实际内网部署、长期负载与磁盘故障演练 |
| Agent        | 可配置模型、有界执行、人工交接后刷新观察、逐项报告                     | 真实模型质量与成本评估               |
| Browser Node | Rust 会话监管、CLI、去重、临时身份隔离、网络元数据、清理与重启恢复工具 | 实际 VM、引擎未知写入及运维演练      |
| Console      | 任务、报告证据、节点注册/撤销/轮换、人工操作和活动记录                 | 真实业务操作体验验收                 |

运行维护与真实环境验收要求见 [部署与运行维护](deploy/README.md)。访问继续使用单一管理员 token，不引入用户、SSO 或多租户。原生 DOM、closed Shadow DOM、跨域 iframe、TRACE 和 API 主备见 [浏览器能力与高可用](docs/browser-capabilities-ha.md)。

API `/health/ready` 检查数据库并返回当前能力，其中 `executionWorkerProtocol: true` 表示支持 worker 协议，不代表模型服务可用。Node doctor 返回 `productionReady: false`；任务校验命令仍返回 `executed: false`。Node 写操作默认关闭，原因与开发测试开关见 [节点说明](crates/browser-node/README.md)。

## 本机启动：Mac + 本地 PostgreSQL

需要 Node.js 24、pnpm 10.30.2，以及已启动的本地 PostgreSQL。在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
# 首次创建专用数据库；已有 proofrun 库时跳过。
createdb -h 127.0.0.1 -p 5432 -U "$(whoami)" proofrun
pnpm dev:local
```

API、Agent、Console 直接运行在 Mac，默认不依赖 Docker。Console 地址为 `http://127.0.0.1:5173`，HTTP API 地址为 `http://127.0.0.1:4101`。只有 API 连接 PostgreSQL，Agent 通过 API 领取任务，Console 通过 Vite 代理访问 API。API 首次启动自动执行数据库迁移。

启动前准备 `.proofrun/local.env`，数据库连接改为实际本机账号，例如当前机器为 `PROOFRUN_DATABASE_URL=postgresql://mac@127.0.0.1:5432/proofrun`。若数据库要求密码，在连接串中填写经过 URL 编码的密码。还需配置两个不同且至少 32 字符的 `PROOFRUN_ADMIN_TOKEN` / `PROOFRUN_WORKER_TOKEN`，以及 `PROOFRUN_MODEL_BASE_URL`、`PROOFRUN_MODEL_API_KEY`、`PROOFRUN_MODEL`；其余可选项见 [.env.example](.env.example)。不要将本机密钥提交到 Git。

模型、密钥和数据库配置读取 `.proofrun/local.env`；case v2 配置读取 `.proofrun/case-profile.json`，首次缺失时按 `internal` 节点池、LLM 单组模式创建；新 v2 每步独立五分钟、10 次动作、LLM 20 次模型请求，cleanup 独立三分钟。后续修改这两个文件后重新运行启动命令。启动器固定本地服务地址并注入配置路径，不再读取容器的 `/var/lib/proofrun/environment.json`。

启动器构建最新代码，在后台运行服务，日志为 `.proofrun/runtime/local-{api,agent,console}.log`，进程信息保存在 `.proofrun/runtime/mac-services.json`。重复运行会重启已确认属于本项目的进程；有运行中的任务时拒绝重启。`pnpm dev:local --no-agent` 可在未配置模型时只启动 API 和 Console。更换数据库不会自动迁移旧任务、报告或节点配对记录。

浏览器任务仍需要独立的 Linux Browser Node；只启动三个服务可以使用控制台和 API，但没有在线节点时无法执行浏览器任务。既有 `proofrun-preview` Docker 环境可显式使用 `pnpm dev:local --with-preview-node` 恢复节点及 TLS 转发，此模式需要 `.proofrun/runtime/compose.yml`、既有容器和匹配数据库的配对记录；不要直接用旧节点身份连接全新数据库。服务就绪不代表模型额度可用或业务验收通过。

本机节点配对完成后，可在 `.proofrun/local.env` 设置 `PROOFRUN_LOCAL_PREVIEW_NODE=true`，让 `pnpm dev:local` 同时恢复 Docker 节点。当前本地 PG 的节点配置位于 `.proofrun/runtime/local-node.toml`，使用独立 home；节点按实时 CPU/内存决定准入，Agent 持续申请授权，不设固定执行槽；旧 `PROOFRUN_AGENT_CONCURRENCY` 已不再读取，可从环境配置删除。旧节点 TOML 须移除 `capacity` 并配置直连地址，详见[节点直连部署](deploy/README.md#节点直连域名与升级)。

需要分别在三个终端前台启动并调试时，每个终端先执行 `set -a; . .proofrun/local.env; set +a`，再分别执行：

```sh
# 终端 A
pnpm dev:api
# 终端 B
pnpm dev:agent
# 终端 C：代理到本机 API 的 4101 端口。
PROOFRUN_API_PROXY=http://127.0.0.1:4101 pnpm dev:console
```

前台方式使用 `.proofrun/local.env` 的 `PROOFRUN_API_PORT=4101`，并将 `PROOFRUN_PUBLIC_URL` 和 `PROOFRUN_CONTROL_URL` 都设为 `http://127.0.0.1:4101`。不要与后台启动方式同时运行。

## 完整启动：Linux 单机开发环境

以下命令均从仓库根目录执行，每个标有“终端”的步骤使用独立终端。需要 Node.js 24、pnpm 10.30.2、Rust 1.98.0、Docker、Linux systemd 用户管理器和 cgroup v2，并预先安装与架构匹配的 **agent-browser 0.38.1 原生二进制**及 Chrome/Chromium。Browser Node 正式服务不能在 macOS 上运行；macOS 可运行数据库、API、Agent 和 Console，节点需部署到 Linux VM，并按 [部署说明](deploy/README.md)配置同源 HTTPS/WSS。

### 1. 安装、构建和保存本机配置（首次执行）

```sh
pnpm install --frozen-lockfile
pnpm build
umask 077
mkdir -p .proofrun
export PROOFRUN_POSTGRES_PASSWORD="$(openssl rand -hex 24)"
export PROOFRUN_ADMIN_TOKEN="$(openssl rand -hex 32)"
export PROOFRUN_WORKER_TOKEN="$(openssl rand -hex 32)"
cat > .proofrun/local.env <<EOF
export PROOFRUN_POSTGRES_PASSWORD="$PROOFRUN_POSTGRES_PASSWORD"
export PROOFRUN_DATABASE_URL="postgresql://proofrun:$PROOFRUN_POSTGRES_PASSWORD@127.0.0.1:5432/proofrun"
export PROOFRUN_ADMIN_TOKEN="$PROOFRUN_ADMIN_TOKEN"
export PROOFRUN_WORKER_TOKEN="$PROOFRUN_WORKER_TOKEN"
export PROOFRUN_PUBLIC_URL="http://127.0.0.1:4100"
export PROOFRUN_ARTIFACT_DIRECTORY="$PWD/.proofrun/api-artifacts"
export PROOFRUN_CONTROL_URL="http://127.0.0.1:4100"
EOF
```

`.proofrun/local.env` 已被 Git 忽略。以后重启时复用该文件，不要重新生成数据库密码；应用不会自动加载环境变量。

### 2. 启动 PostgreSQL（终端 A）

```sh
. .proofrun/local.env
docker compose -f deploy/postgres.compose.yml up -d --wait
```

### 3. 启动 API（终端 B，保持运行）

```sh
. .proofrun/local.env
pnpm dev:api
```

另开终端确认 API 与数据库就绪：

```sh
curl -fsS http://127.0.0.1:4100/health/ready
```

### 4. 配对并启动 Browser Node（Linux 终端 C，保持运行）

先把下面两个路径改成已安装的**原生**引擎和浏览器路径。`allow_unverified_writes = true` 只用于受控开发环境；默认配置为 false，尚不能用于生产业务写入。

```sh
. .proofrun/local.env
umask 077
export PROOFRUN_AGENT_BROWSER_BIN=/opt/proofrun/bin/agent-browser
export PROOFRUN_CHROME_BIN=/usr/bin/chromium
test -x "$PROOFRUN_AGENT_BROWSER_BIN" && test -x "$PROOFRUN_CHROME_BIN"
cat > .proofrun/node.toml <<EOF
home = "$PWD/.proofrun/node"
gateway_url = "ws://127.0.0.1:4100/v1/nodes/connect"
credential_file = "credential.json"
pool = "internal"
public_url = "https://browser-node-01.example.com"
listen = "127.0.0.1:9310"
memory_reserve_bytes = 1073741824
session_reserve_bytes = 536870912
agent_browser_bin = "$PROOFRUN_AGENT_BROWSER_BIN"
chrome_bin = "$PROOFRUN_CHROME_BIN"
artifact_upload_url = "http://127.0.0.1:4100/v1/artifacts"
allow_unverified_writes = true
EOF
target/debug/proofrun-node --config .proofrun/node.toml doctor
```

检查 `doctor` 输出中的 `errors`，确认依赖探测通过后签发配对码。首次配对执行以下命令；以后直接运行最后一行 `serve`，不要重新签发配对码。

```sh
set -o pipefail
curl -fsS -X POST http://127.0.0.1:4100/v1/node-pairings \
  -H "Authorization: Bearer $PROOFRUN_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"type":"node.enroll","pool":"internal","name":"local-linux"}' \
  | node -p 'JSON.parse(require("node:fs").readFileSync(0,"utf8")).pairingToken' \
  > .proofrun/pairing-token
target/debug/proofrun-node --config .proofrun/node.toml pair \
  --pairing-token-file .proofrun/pairing-token
rm .proofrun/pairing-token
target/debug/proofrun-node --config .proofrun/node.toml serve
```

### 5. 启动执行 Agent（终端 D，保持运行）

填写实际 Chat Completions 服务的地址、密钥与模型名。该服务需要支持工具调用；这里没有默认模型或测试密钥。

```sh
. .proofrun/local.env
export PROOFRUN_MODEL_BASE_URL='https://你的模型服务地址/v1'
export PROOFRUN_MODEL_API_KEY='你的模型密钥'
export PROOFRUN_MODEL='你的模型名'
export PROOFRUN_MODEL_VISION=false
pnpm dev:agent
```

需要用截图作为模型输入时，将 `PROOFRUN_MODEL_VISION` 设为 `true`，并使用支持图片输入的模型。模型服务若只接受 `max_tokens`，设置 `PROOFRUN_MODEL_TOKEN_PARAMETER=max_tokens`。

### 6. 启动 Console（终端 E，保持运行）

```sh
pnpm dev:console
```

打开 Vite 输出的本机地址，在页面输入 `.proofrun/local.env` 中的 `PROOFRUN_ADMIN_TOKEN`。可在另一个已加载配置的终端检查节点是否在线：

```sh
. .proofrun/local.env
curl -fsS -H "Authorization: Bearer $PROOFRUN_ADMIN_TOKEN" \
  http://127.0.0.1:4100/v1/nodes
```

提交任务前，确认任务的 `environment.nodePool` 为 `internal`，目标 URL 能从 **Node 所在机器**访问，且验收项由上层定义。仓库中的 `tests/scenarios/basic-form/task.json` 指向示例地址 `127.0.0.1:8080/form`，未启动对应页面服务时只适合做结构校验：

```sh
pnpm validate:task tests/scenarios/basic-form/task.json
# 真实目标可用后，提交自己的任务并下载报告与证据。
pnpm accept:task /absolute/path/to/verification-task.json
```

停止时在 B–E 终端按 Ctrl+C；数据库可用 `docker compose -f deploy/postgres.compose.yml stop` 停止，保留数据卷。上述流程仅用于 Linux 单机开发；跨主机节点必须使用 HTTPS/WSS，不能将示例中的 `127.0.0.1` 直接带到 VM。完整环境变量见 [.env.example](.env.example)，生产服务模板见 [部署说明](deploy/README.md)。

`pnpm test:agent:integration` 同时覆盖旧路径与服务端运行时的新旧行为比较、决定幂等及失效关闭。模拟节点与模型输出不代表真实浏览器验收。

`pnpm check` 与构建不要求 PostgreSQL 或模型密钥。集成测试独立运行 `pnpm test:api` / `pnpm test:agent:integration` / `pnpm test:agent:linux`，见 [API 运行说明](apps/api/README.md)。

## Agent 循环与身份简化

新执行只使用 LLM，context 收敛为七个模块，进度经统一 `progress` 保存。案例不保存或恢复 profile 基准；身份材料注入临时会话，setup 门禁、租约、账号并发和物理关闭继续有效。历史双跑报告可读，新增双跑入口已退役。架构与删除清单见[简化设计](docs/agent-loop-simplification-design.md)。

## 协议修改

`contracts/schemas` 是协议的唯一源文件。修改后执行 `pnpm contracts:generate` 并一并提交生成结果。CI 使用 `pnpm contracts:check` 检查漂移。

上层使用[Case API](docs/public-api.md)及其兼容规则；VerificationTask、worker、节点和模型协议属于内部实现，随项目组件配套演进。这不等于生产环境验收完成。Rust 在构建期从 NodeCommand schema 生成命令类型，并在入口执行原始 Schema 校验。节点事件由独立 schema 描述。协议细节见 [contracts/README.md](contracts/README.md) 和 [节点协议](docs/node-protocol.md)。

## 设计入口

文档只维护运行说明、架构、设计与 ADR；单次验证、迁移过程和任务分析不作为常驻文档。测试入口与覆盖边界见 [tests/README.md](tests/README.md)，真实环境验收见 [部署说明](deploy/README.md)。

- [Agent 运行与模型配置](apps/agent/README.md)
- [整体架构](docs/architecture.md)
- [双 MCP 与外部验证执行设计](docs/mcp-execution-design.md)
- [DevPass 外部账号配置与使用](apps/api/src/modules/account-providers/README.md#devpass-外部账号)
- [Console 运行与业务页面](apps/console/README.md)
- [Console 视觉规范与 x.ai 样式研究](docs/console-design.md)
- [控制面运行与协议](apps/api/README.md)
- [Browser Node 结构图](docs/browser-node-architecture/README.md)
- [Browser Node 架构与技术选型](docs/browser-node-design.md)
- [Browser Node 运行与限制](crates/browser-node/README.md)
- [新仓库与职责边界](docs/decisions/0001-platform-boundaries.md)
- [agent-browser 适配边界与 POC 结论](docs/decisions/0002-browser-engine.md)

独立免登录 HITL 处理页、实时浏览器画面、受限输入和完成交接现已接入，使用与验证边界见 [HITL 说明](docs/hitl.md)。
