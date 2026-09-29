# proofrun-node

远端浏览器节点的首版实现：一个 Rust 二进制，主动连接控制面，每个会话通过 systemd 用户服务监管独立的 agent-browser daemon 和浏览器。节点不运行模型，也不分析 Spec。

## 当前能力

- Tokio 主服务、主动 WebSocket 连接、凭据认证、心跳、重连和结果 ACK。
- 本机容量准入、会话内单操作、租约续期、fence / nodeEpoch 校验。
- 每个会话独立 profile、socket 目录和进程范围；取消、超时、失联后的租约过期均触发关闭。
- SQLite 命令去重、结果 outbox、重启恢复。未提交结果恢复为 UNKNOWN，不自动重放动作。
- 固定 agent-browser 0.38.1 原生 CLI，观察、导航、点击、填写、按键、滚动和条件等待。
- 对外返回绑定 observationId 的元素目标，CLI refs 留在适配层；支持在 open Shadow DOM 中查找文本条件。
- PNG 截图落盘、SHA-256、额度限制、HTTP 上传重试；验证存储回执后才释放本地文件。

API 已提供一次性配对、凭据签发、主动连接网关与证据存储。节点首次连接上报身份、节点池、容量和租约上限；控制面结合持久占用进行调度，接入步骤见 [API 说明](../../apps/api/README.md)。

## 运行

服务要求 Linux、systemd 用户管理器、cgroup v2。macOS 只用于编译和直接引擎适配测试。以独立的普通用户运行，启用该用户的 linger。引擎使用与机器架构匹配的原生二进制，不能用 npm 启动器替代固定的执行文件。

```sh
cargo build --locked --release -p proofrun-node
target/release/proofrun-node --config deploy/node.example.toml doctor
target/release/proofrun-node --config deploy/node.example.toml pair --pairing-token-file /private/path/pairing-token
target/release/proofrun-node --config deploy/node.example.toml serve
```

先调整示例中的绝对路径、资源池和控制面地址，用管理员签发的一次性配对码执行 `pair`，它会将机器凭据写入 credential_file（0600）。成功后删除配对码文件。配对不启动浏览器，不自动改写 TOML。安装示例见 [deploy](../../deploy/README.md)。配置不会自动读取 `.env`；可用环境变量覆盖 home、引擎路径和 Chrome 路径。

`doctor` 探测配置、引擎版本和 systemd 用户管理器，但不启动浏览器、不验证网关或执行故障注入。读取其 JSON 检查结果；退出码 0 不代表依赖全部可用，也不代表生产验收通过。

`serve --stdio` 是集成测试入口，使用相同的命令处理逻辑，标准输入 EOF 会关闭会话。它不加载网络凭据、不上传证据，也不实现网络 outbox 重送。`session-host` 是内部管道协议，不是另一个公共服务。

需要在浏览器中手动验证导航、观察、截图、target、点击和填写时，可运行[本地调试页](../../tests/browser-node/debug-ui/README.md)。调试页启动同一二进制的内部 `session-host`，适合 macOS 上的真实 Chrome 适配测试；它不覆盖正式节点的网关与 systemd 路径。

## 模块

| 模块                       | 职责                                               |
| -------------------------- | -------------------------------------------------- |
| `node.rs`                  | 命令入口、身份/租约校验、去重与提交结果            |
| `gateway/`                 | 主动连接、传输限额、重连、ACK、上传任务            |
| `sessions/`                | 本地容量、生命周期、内部 host 管道、取消与截止时间 |
| `engine/`                  | 固定 CLI 参数、观察目标映射、条件等待              |
| `process.rs`               | 有界进程调用、systemd 身份和 cgroup 关闭确认       |
| `store.rs`                 | 独立 SQLite 线程、短事务、恢复记录和 outbox        |
| `artifacts.rs`             | 截图落盘、额度、hash、上传及存储回执               |
| `protocol.rs` / `build.rs` | 原始 JSON Schema 校验及构建期 Rust 类型生成        |

只有会话操作需要串行。续期和关闭独立处理，不排在浏览器等待后面。SQLite 提交前不释放同一会话的操作许可；关闭状态不能核实则保留 QUARANTINED 占用。

## 明确限制

写操作默认关闭，包括导航。检查过的 agent-browser 上游源码在连接异常路径可能重试，尚未证明当前发布二进制在“业务成功、响应丢失”时不会再次写入。开发测试必须显式设置 `allow_unverified_writes = true`；该开关不会将 engineWritesVerified 变成 true。节点的 commandId 去重不能约束引擎内部重试，不能宣称业务 exactly-once。

已补充凭据轮换/原配对回执恢复、Cookie/localStorage 登录复用、网络元数据、停机清理和显式主机重启恢复工具，见 [迁移交付记录](../../docs/migration-completion.md)。尚未提供 iframe 条件等待、closed Shadow DOM、完整 TRACE、磁盘故障演练和真实内网 VM 部署验收。当前截图是多次 CLI 调用中的一次采样，`atomic: false`；观察成功不等于业务验收通过。

跨主机重启导致 boot ID 改变，或创建意图没有可验证的 cgroup 身份时，节点保守地停止接单并要求恢复处理。不要通过删除数据库、清空 home 或重用 sessionId 来解除未核实的占用。维护工具可以清理确认关闭的旧 profile 和命令内容，仍保留去重身份。实际 VM 重启后的运维演练尚未验收。

协议详见 [node-protocol](../../docs/node-protocol.md)，测试命令和范围见 [验证记录](../../docs/browser-node-validation.md)。

独立免登录 HITL 处理页、实时浏览器画面、受限输入和完成交接现已接入，使用与验证边界见 [HITL 说明](../../docs/hitl.md)。
