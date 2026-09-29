# Browser Node 首版验证记录

日期：2026-09-23。对象：本仓库的 Rust Browser Node 首版实现，不是旧项目 POC。测试不调用外部业务系统，不使用个人浏览器 profile。

## 验证范围

| 环境                                                     | 验证内容                                                     | 结果 |
| -------------------------------------------------------- | ------------------------------------------------------------ | ---- |
| macOS arm64 / Rust 1.98                                  | 9 项 Rust 可靠性测试                                         | 通过 |
| Node.js 24 / pnpm                                        | 6 项协议约束测试、TS 类型检查、Schema 类型生成漂移检查       | 通过 |
| Linux arm64 / Debian 12 / systemd 用户管理器 / cgroup v2 | 11 组会话与故障场景，使用故意制造故障的假引擎进程            | 通过 |
| 同一 Linux 环境 / loopback WebSocket + HTTP 测试控制面   | 认证、重连、ACK、上传重试、存储确认、关闭事件                | 通过 |
| macOS arm64 / agent-browser 0.38.1 / 本机 Chrome         | 普通表单与两层 open Shadow DOM、元素引用、条件等待、真实截图 | 通过 |

构建基线：`pnpm check`、`pnpm build`、`cargo clippy --locked --workspace --all-targets -- -D warnings`。捕获的 49 条 Node 输出使用 TS 侧 Ajv 校验通过，覆盖心跳、命令结果、证据可用与会话关闭事件。

## Linux 故障验证

`tests/browser-node/fake_engine.py` 会创建脱离 CLI 的 daemon 与后代进程，故意忽略 SIGTERM；close 返回成功时也不清理它们。这样可以检查 systemd/cgroup 的实际回收，避免仅凭 CLI 退出误判关闭。

1. 两个独立会话运行，第三个会话因容量不足被拒绝。
2. 观察与 PNG spool 完成，证据保持 PENDING。
3. 相同 commandId 重发返回原结果，写入计数仍为一次；不同 payload 被拒绝。
4. 动作后旧 observationId 失效。
5. 长等待期间拒绝第二个浏览器操作，但关闭能及时中断；清理一个会话不影响另一个。
6. 错误 fence / 旧 nodeEpoch 被拒绝。
7. 假引擎已写入但延迟响应，节点超时返回 MAY_HAVE_HAPPENED；重发相同命令不重复写入。
8. 长等待期间可以续期，操作存活超过原租约期限；随后取消返回 CANCELLED。
9. 空闲会话租约到期会清理其所有后代并释放占用。
10. 强制 SIGKILL 主节点后重启，nodeEpoch 变化；旧会话关闭，未提交结果恢复 UNKNOWN，不重放。
11. 晚到的短租约授权被拒绝，不从收包时重新计时。

这能证明节点层去重和进程管理的行为，不能证明真实引擎内部没有重试。

## 网络与证据交付

测试控制面验证 Bearer 认证，在结果提交之后、ACK 之前断开 WebSocket，检查节点重连并重送同一结果；ACK 后检查 SQLite outbox 对应记录消失。证据入口第一次 PUT 返回 503，第二次验证 SHA-256 并返回持久化回执；随后检查 artifact.available、SQLite 状态和本地文件删除。关闭后还验证可重送的 session.closed / closureVerified。

该测试使用 loopback WS/HTTP，未覆盖生产证书链、代理、真实内网链路或正式控制面数据库。传输实现支持 WSS/HTTPS，但不把明文回环测试记为 TLS 联调通过。

## 真实引擎验证

`real_engine_smoke.py` 直接启动同一个二进制的内部 session-host，使用临时 profile、唯一 session 和本地 HTTP 页面，完成：

- 原生 CLI 启动真实 Chrome。
- 每次观察后的平台 target 映射和元素操作。
- 普通表单与两层 open Shadow DOM 表单各提交一次。
- 使用节点封装的条件等待读取 Shadow DOM 中的完成文本。
- HTTP 服务独立计数确认两次提交和正确字段值。
- 生成真实 PNG，关闭后检查当前测试 session 的 daemon 未遗留。

该冒烟测试运行在 macOS，不包含 Linux systemd/cgroup；不能替代 Linux 真实 Chrome / 内网 VM 的整体部署验收。

## 复现

```sh
pnpm check
pnpm build
cargo clippy --locked --workspace --all-targets -- -D warnings

# Docker 中运行 systemd，脚本结束时删除自己创建的容器。
pnpm test:node:linux

# 原生二进制和 Chrome 路径按本机填写；测试不会下载安装引擎。
PROOFRUN_AGENT_BROWSER_BIN=/absolute/path/to/agent-browser \
PROOFRUN_CHROME_BIN=/absolute/path/to/chrome \
python3 tests/browser-node/real_engine_smoke.py

# 测试脚本会打印临时结果目录；复制其中 events.jsonl 后可跨语言验证。
node tests/browser-node/validate-events.mjs /absolute/path/to/events.jsonl
```

`run-linux.sh` 的容器需要 privileged 以运行独立 systemd/cgroup；不挂载 Docker socket、不发布端口、只读挂载项目。也可在准备好的普通 Linux 测试用户下设置 PROOFRUN_TEST_BINARY，直接执行两份 Python 集成测试。故障夹具需要 python3，Rust/TLS 依赖构建需要 C 工具链与 cmake。

尚未验证：真实引擎在业务已提交但返回链路丢失时的行为、主机重启后的人工恢复流程、磁盘满/损坏、证据孤儿回收、长期运行记录增长、生产 TLS/凭据轮换与高并发负载。这些是后续生产验收项目，当前 engineWritesVerified 保持 false。

## 执行 Agent 接入后的补充验证

2026-09-24 已用真实 API/PostgreSQL、Rust Node、systemd、agent-browser 0.38.1 和 Linux Chromium 完成普通表单及两层开放 Shadow DOM 场景。模型仍由脚本夹具替代；具体操作、证据和耗时范围见 [Agent 验证记录](agent-validation.md)。本轮同时验证完整页面快照及 ACK 唤醒截图上传，生产写入开关与真实内网验收结论不变。

本轮补充 3 个 Rust 测试，覆盖登录快照的路径/权限/原子导入、网络字段脱敏与条数上限、关闭且已确认交付会话的保留策略；当前 Rust 共 13 个测试。使用 `tests/browser-node/auth_network_smoke.py` 在 macOS Chrome 和 Linux Chromium 中验证 Cookie/localStorage 从一个会话保存后在另一独立 profile 恢复，并验证真实 HTTP 200 状态码与 URL 脱敏。该测试不验证业务 SSO/MFA，不证明网络捕获完整或服务端写入恰好一次。实际 VM 重启和生产轮换仍待环境演练。
