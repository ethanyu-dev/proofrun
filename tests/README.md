# 测试与验证

所有命令从仓库根目录执行。测试结果以当前提交的运行日志为准；本文件维护入口、依赖和覆盖边界，不保存单次运行记录或累计测试数量。

## 工程检查

```sh
pnpm install --frozen-lockfile
pnpm check
cargo clippy --locked --workspace --all-targets -- -D warnings
pnpm build
```

`pnpm check` 包含契约生成漂移、格式、类型、契约测试、验收材料审计测试、Agent 测试、业务测评工具测试、Console 测试及 Rust 测试，不要求数据库或模型密钥。依赖版本以根目录工具链与锁文件为准。

## 测试层次

| 入口                            | 依赖与验证范围                                                               | 关键不覆盖项                                    |
| ------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- |
| `pnpm test:contracts`           | JSON Schema、输入、报告及 TS/Rust 协议边界                                   | 租约实际授权、业务语义                          |
| `pnpm test:acceptance`          | 离线导出的身份、摘要、验收引用、缺失和重复样本                               | 真实业务结论、部署版本及供应商质量              |
| `pnpm test:agent`               | 本地模型 HTTP 与执行端口夹具；预算、上下文、证据、工作流、错误恢复、人工交接 | 真实供应商质量、真实浏览器                      |
| `pnpm test:console`             | 受控 fetch、任务定义、凭据存储、证据摘要、交接输入、对照视图数据             | 浏览器布局、真实网络和业务体验                  |
| `pnpm test:node`                | Rust 去重、恢复、截止时间、关闭、登录与网络约束                              | 引擎内部重试、生产 VM                           |
| `pnpm test:api`                 | 临时 PostgreSQL、HTTP、WebSocket；调度、鉴权、容量、报告、HITL、HA、Case API | 节点由协议夹具模拟；不证明实际进程关闭          |
| `pnpm test:agent:integration`   | 真实 API、数据库和执行 Agent；报告、租约、取消、超时、未知写入               | 模型与节点为夹具                                |
| `pnpm test:node:linux`          | Docker 内 systemd/cgroup、Rust Node、故障引擎；进程回收、网关重送、证据交付  | 真实 Chrome、模型、生产 TLS                     |
| `pnpm test:control-plane:linux` | 真实 API、PostgreSQL、两台 Rust Node 与 systemd，故障引擎                    | 真实业务页面与模型                              |
| `pnpm test:agent:linux`         | Linux Chromium、固定原生引擎、真实 Agent/API；表单、Shadow DOM、证据与关闭   | 模型为脚本夹具；不证明业务成功率或成本          |
| `pnpm test:hitl:linux`          | Linux 实时画面、坐标与中文输入、交还原会话及关闭                             | 执行者为夹具；回环 WS 不证明生产 TLS、SSO/MFA   |
| `pnpm test:deploy`              | 构建后用 Docker 检查 Caddy 路由、空库迁移、鉴权和重启持久化                  | HTTP；HA 模板指向同一测试 API，不证明跨主机切换 |

JEV 图片与候选测试包含在 `pnpm test:agent`：合成 PNG 的缩放、来源和存档，独立视觉开关，超过 255 项的分组，以及 Box 存在性、唯一性、坐标与预算拒绝。模型回答为夹具，不能据此声称真实多模态准确率、置信度校准或任务成功率。

## 数据库集成

```sh
# 专用测试实例；账户需要新建和删除随机测试数据库的权限。
export PROOFRUN_TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/proofrun
pnpm test:api
pnpm test:agent:integration
```

不能使用业务数据库作为测试管理入口。每个进程创建自己的随机数据库，结束时关闭连接并删除；HA 测试也只终止自己创建的锁连接。节点心跳不能替代 worker 续租；HITL 和 TRACE 夹具独立续租，并在完成或取消前停止。负载回归应预先固定并发和批次，保留失败日志，不按失败结果追加重试。

## Linux 浏览器与故障场景

```sh
# 按 Docker 架构选择 x64 或 arm64，下载器核对固定版本 SHA-256。
node scripts/download-test-engine.mjs x64 .proofrun/bin/agent-browser-linux-x64
PROOFRUN_TEST_AGENT_BROWSER="$PWD/.proofrun/bin/agent-browser-linux-x64" \
PROOFRUN_TEST_FULL_LINUX=true pnpm test:agent:linux
```

完整入口包含登录快照与网络、systemd 生命周期、网关、DOM/Shadow DOM/iframe/TRACE 和 HITL。容器中的 privileged 仅用于一次性 systemd/cgroup 测试，不能复制到生产服务。脚本创建独立容器、网络与数据并负责回收；需要 Docker、Python 3 及可构建 Rust 的环境。

故障引擎会生成脱离 CLI 且忽略 SIGTERM 的后代进程，验证真正的进程范围回收。真实 Chromium 夹具访问回环页面，由页面服务独立计数写入，并下载证据核对摘要；仍不能证明引擎在真实业务响应丢失时不会内部重试。

直接验证原生适配器（不包含 Linux supervisor 全链路）：

```sh
PROOFRUN_AGENT_BROWSER_BIN=/absolute/path/to/agent-browser \
PROOFRUN_CHROME_BIN=/absolute/path/to/chrome \
python3 tests/browser-node/real_engine_smoke.py
node tests/browser-node/validate-events.mjs /absolute/path/to/events.jsonl
```

`real_engine_smoke.py` 同时覆盖普通输入框、两层 Shadow DOM 与同源 iframe 的定向 Tab、真实按键和失焦事件、过期观察拒绝、当前焦点回执，以及焦点被监听器转移时停止按键；独立 HTTP 计数核对实际收到的 Tab。页面只在本机回环地址运行，不验证生产邀请码提示或 Linux 会话监管。

能力场景见 `browser-node/capabilities_smoke.py`，包含当前截图视觉点击及同视口新增覆盖层后的拒绝；登录与网络场景见 `browser-node/auth_network_smoke.py`。登录快照只覆盖 Cookie/localStorage，网络证据只有有界脱敏元数据，不保证捕获完整。

人工输入网络隔离回归见 `browser-node/input_network_smoke.py`，使用同样的引擎与 Chrome 环境变量。真实浏览器的后台标签页阻塞二十二秒、前台接口持续等待时，验证前台点击完成、新请求证据保留及独立写入计数；不访问生产网站，也不证明某次线上超时的唯一原因。该场景已纳入完整 Linux 回归。

## Console 与真实环境

业务端到端测评见 [场景说明](scenarios/README.md)：`pnpm test:e2e:harness` 验证独立判定与恢复逻辑，`pnpm test:e2e:linux` 跑真实浏览器和脚本模型，显式设置真实模型后可运行 12 个场景。判定核对持久化业务事实与证据正文，已知缺陷正确报告 FAILED 也算测评通过；不与单纯文件完整性审计混为一谈。

页面联调入口、临时凭据和夹具回收见 [Console README](../apps/console/README.md#验证)；独立 Node 调试页见 [调试页 README](browser-node/debug-ui/README.md)。夹具 PNG 和协议状态不构成真实业务界面验收，也不能仅凭下载按钮存在就认定文件落盘。

真实模型回放工具见 [脚本说明](../scripts/README.md)，实际业务验收与 VM 故障演练见 [部署说明](../deploy/README.md#业务验收)。模型输出 PASSED、任务 COMPLETED、证据摘要正确分别代表不同事实，不能互相替代。

## 薄身份库与完整 profile

- `pnpm test:api`：六字段私密存储、版本冻结、选择租约；HTTP/WebSocket 贯通默认身份选择、成功 HITL 发布与“无法处理”整例终态。浏览器结果使用协议夹具。
- `pnpm test:agent`：单次身份选择工具调用、无凭据模型输入、无效引用与人工分支。
- `pnpm test:identity:profile`：设置 `PROOFRUN_AGENT_BROWSER_BIN`（0.38.1 原生 CLI）和 `PROOFRUN_CHROME_BIN` 后，真实 Chrome 回环验证完整 profile 的 Cookie 与站点状态复用、HITL 重启、业务修改隔离。此入口不覆盖 Linux 监管、SSO 或生产业务。

### 通用执行策略回归

`pnpm test:agent` 包含持续子目标、权威进度、循环检测、位置线索、预算与旧节点兼容；`pnpm test:console` 包含诊断的两种请求格式。模型和控制面夹具不能代表真实业务验收。`capabilities_smoke.py` 在真实 Chromium 中检查新旧滚动命令、iframe 容器及观察失效。

需要真实模型时，在浏览器节点主机运行 `python3 tests/agent/guidance-browser-fixture.py`（仅监听 127.0.0.1:8082），分别执行 `/long-form`、`/nested`、`/wizard`。固定模型与预算，检查报告、真实动作和 `/metrics` 的禁止提交计数；此类结果仍仅是本地合成业务。外部回归保留原任务标准、约束、预算，不因无法触发禁止操作而放宽结论。

`tests/agent/settlement.test.mjs` 验证同轮结论先保存、未知副作用后不丢结果、无效证据禁止动作、慢回复后的预算内只读收尾，以及历史正文去重边界。HTTP 模型和页面为夹具，不能替代真实模型完成率比较。真实对照仍使用相同模型、原始任务和预算，分别统计可靠结论与未完成项。

## 统一计划执行回归

`pnpm test:agent` 中的 `planned-execution.test.mjs` 覆盖首轮计划随动作提交、计划字段值复用、结构化复核、批量面板采集、上下文裁剪、请求预算和身份代次失效。回复及控制面由脚本生成，只证明执行协议。

```bash
# 使用本机固定版本的原生引擎和 Chrome 绝对路径。
export PROOFRUN_AGENT_BROWSER_BIN=/absolute/path/to/agent-browser
export PROOFRUN_CHROME_BIN=/absolute/path/to/chrome
cargo build --locked -p proofrun-node
pnpm test:agent:planned-browser
```

浏览器用例创建临时独立会话，在真实 Rust session-host/Chrome 中填写和提交，由回环 HTTP 服务独立计数，结束关闭会话。未提供浏览器路径时明确跳过。模型、控制面证据上传和租约仍为夹具；不验证真实供应商质量、生产账号或 API 数据库持久化。

## 请求归属与报告汇总

- `apps/api/test/requests.test.ts` 使用独立临时 PostgreSQL 数据库和真实 HTTP 路由，覆盖三 case 双跑归属、同请求重试/重排、并发交叉批次、共享 case、关联写入故障整批回滚、报告部分/终态投影、缺报告、组间差异、微秒时间相同的分页、搜索完整性、原子重跑、旧数组与认证隔离。
- `tests/contracts/request-summary.test.mjs` 覆盖唯一业务标准去重、跨 case 同名标准、混合单/双组、取消和超时缺报告、确认失败优先、覆盖差异、重复记录、准备受阻与清理异常的不同口径。
- `tests/console/requests.test.ts` 覆盖请求草稿身份稳定性、真实 ApiClient 序列化、请求详情跳转、部分结果文本、两组来源、证据归档禁用及来源导航；静态渲染不替代浏览器检查。

2026-10-19 在隔离测试控制面完成浏览器检查：请求列表展开 case、详情和报告切换、执行详情返回来源请求、对象格式实际提交、整请求重跑、报告 JSON 下载与内容核对。390px 与 1280px 视口无横向溢出，浅/深色可读，未捕获控制台错误。测试使用构造报告，没有连接真实浏览器执行节点或模型，不能作为邀请活动等实际业务验收。

运行方式：`pnpm test:contracts`、`pnpm test:console`，以及配置独立 `PROOFRUN_TEST_DATABASE_URL` 后执行 `pnpm test:api`。数据库测试自行创建和删除临时数据库，不使用生产任务数据。
