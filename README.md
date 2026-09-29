# ProofRun

接收上层 Agent 定义的验证任务，调度内网浏览器节点执行，交付有证据的验收报告。

**Browser Node、最小控制面与执行 Agent 已接通，并通过脚本模型驱动的 Linux 真实浏览器闭环验证。模型服务和型号均可配置，Console 已接入任务、节点查询与证据报告。没有 Spec Runtime，也没有需求分析、Spec 生成或验收标准生成流程。** 上层 Agent 负责这些定义；ProofRun 负责输入校验、实际环境预检、执行与报告。

**结构化任务接入：[Case API v2](docs/public-api-v2.md) · [批量示例](contracts/examples/public-api/cases-v2.json)。每个对象对应独立任务，内部按 exec_order 串行执行，业务清理由关联任务处理。**

**原单 case 接入：[Case API](docs/public-api.md) · [OpenAPI](contracts/public-api.openapi.json) · [case 示例](contracts/examples/public-api/case.json)。** 调用方提交任务描述、待测 URL、可选步骤和验收项；环境、身份与预算由[平台配置](docs/case-platform-config.md)提供。

## 项目结构

```text
apps/
  api/                 控制面：任务、节点、队列、租约、证据与报告
  agent/               验证执行 Agent：根据已定义标准观察和操作浏览器
  console/             控制台：任务、节点、证据报告、人工介入
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
| Browser Node | Rust 会话监管、CLI、去重、登录存储复用、网络元数据、清理与重启恢复工具 | 实际 VM、引擎未知写入及运维演练      |
| Console      | 任务、报告证据、节点注册/撤销/轮换、人工操作和活动记录                 | 真实业务操作体验验收                 |

运行维护与真实环境验收要求见 [部署与运行维护](deploy/README.md)。访问继续使用单一管理员 token，不引入用户、SSO 或多租户。原生 DOM、closed Shadow DOM、跨域 iframe、TRACE 和 API 主备见 [浏览器能力与高可用](docs/browser-capabilities-ha.md)。

API `/health/ready` 检查数据库并返回当前能力，其中 `executionWorkerProtocol: true` 表示支持 worker 协议，不代表模型服务可用。Node doctor 返回 `productionReady: false`；任务校验命令仍返回 `executed: false`。Node 写操作默认关闭，原因与开发测试开关见 [节点说明](crates/browser-node/README.md)。

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
capacity = 1
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

`pnpm check` 与构建不要求 PostgreSQL 或模型密钥。集成测试独立运行 `pnpm test:api` / `pnpm test:agent:integration` / `pnpm test:agent:linux`，见 [API 运行说明](apps/api/README.md)。

## JEV / LLM 并行对比

任务详情点击「并行对比 JEV / LLM」，系统复制相同任务目标、验收标准与预算，创建两个独立会话。详情页并列展示两组实时画面、动作、模型请求与最终报告。需要 Node `capacity = 2`、Agent `PROOFRUN_AGENT_CONCURRENCY=2` 和 `TYPESAFE_API_KEY`。HTTPS Console 自动使用 WSS。启动配置、使用方式与实测边界见 [并行对比说明](docs/parallel-comparison.md)。

## 协议修改

`contracts/schemas` 是协议的唯一源文件。修改后执行 `pnpm contracts:generate` 并一并提交生成结果。CI 使用 `pnpm contracts:check` 检查漂移。

上层使用[Case API](docs/public-api.md)及其兼容规则；VerificationTask、worker、节点和模型协议属于内部实现，随项目组件配套演进。这不等于生产环境验收完成。Rust 在构建期从 NodeCommand schema 生成命令类型，并在入口执行原始 Schema 校验。节点事件由独立 schema 描述。协议细节见 [contracts/README.md](contracts/README.md) 和 [节点协议](docs/node-protocol.md)。

## 设计入口

文档只维护运行说明、架构、设计与 ADR；单次验证、迁移过程和任务分析不作为常驻文档。测试入口与覆盖边界见 [tests/README.md](tests/README.md)，真实环境验收见 [部署说明](deploy/README.md)。

- [Agent 运行与模型配置](apps/agent/README.md)
- [整体架构](docs/architecture.md)
- [Console 运行与业务页面](apps/console/README.md)
- [Console 视觉规范与 x.ai 样式研究](docs/console-design.md)
- [控制面运行与协议](apps/api/README.md)
- [Browser Node 结构图](docs/browser-node-architecture/README.md)
- [Browser Node 架构与技术选型](docs/browser-node-design.md)
- [Browser Node 运行与限制](crates/browser-node/README.md)
- [新仓库与职责边界](docs/decisions/0001-platform-boundaries.md)
- [agent-browser 适配边界与 POC 结论](docs/decisions/0002-browser-engine.md)

独立免登录 HITL 处理页、实时浏览器画面、受限输入和完成交接现已接入，使用与验证边界见 [HITL 说明](docs/hitl.md)。
