# 测试与验证

所有命令从仓库根目录执行。测试结果以当前提交的运行日志为准；本文件维护入口、依赖和覆盖边界，不保存单次运行记录或累计测试数量。

## 工程检查

```sh
pnpm install --frozen-lockfile
pnpm check
cargo clippy --locked --workspace --all-targets -- -D warnings
pnpm build
```

`pnpm check` 包含契约生成漂移、格式、类型、契约测试、Agent 测试、Console 测试及 Rust 测试，不要求数据库或模型密钥。依赖版本以根目录工具链与锁文件为准。

## 测试层次

| 入口                            | 依赖与验证范围                                                               | 关键不覆盖项                                    |
| ------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- |
| `pnpm test:contracts`           | JSON Schema、输入、报告及 TS/Rust 协议边界                                   | 租约实际授权、业务语义                          |
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

能力场景见 `browser-node/capabilities_smoke.py`；登录与网络场景见 `browser-node/auth_network_smoke.py`。登录快照只覆盖 Cookie/localStorage，网络证据只有有界脱敏元数据，不保证捕获完整。

## Console 与真实环境

页面联调入口、临时凭据和夹具回收见 [Console README](../apps/console/README.md#验证)；独立 Node 调试页见 [调试页 README](browser-node/debug-ui/README.md)。夹具 PNG 和协议状态不构成真实业务界面验收，也不能仅凭下载按钮存在就认定文件落盘。

真实模型回放工具见 [脚本说明](../scripts/README.md)，实际业务验收与 VM 故障演练见 [部署说明](../deploy/README.md#业务验收)。模型输出 PASSED、任务 COMPLETED、证据摘要正确分别代表不同事实，不能互相替代。
