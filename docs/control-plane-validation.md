# 控制面迁移与验证记录

日期：2026-09-24。本批从新协议重建最小控制面，保留内网节点主动连接、全局队列与本机容量两层约束，没有复制旧项目的 Spec Runtime、模型循环或历史接口。

## 已交付

- 单实例 Fastify API、PostgreSQL 自动建表和实例锁。
- 一次性配对、机器凭据签发、Rust `pair` CLI、节点撤销。
- 不可变任务快照、按资源池调度、并发领取和容量预留。
- worker 独立短租约、Node 心跳上限、服务端签发会话身份与 fence。
- 先持久化再投递、同 ID 命令幂等、结果去重与提交后 ACK。
- 取消、预算到期、worker 失联和 Node 重启后的停止与关闭确认。
- DOM 证据归档、PNG 校验及持久化回执、证据归属和报告语义约束。
- HTTP 接入说明、开发数据库配置、独立集成测试脚本与 CI 检查。

本记录中的 worker 由固定测试执行器替代；后续已接入 apps/agent，新增范围见 [Agent 验证记录](agent-validation.md)。生产未知写入验证尚未完成，Node 开发写入开关不会把 `engineWritesVerified` 改成 true。

## API 集成：真实 PostgreSQL、HTTP 和 WebSocket

入口：`pnpm test:api`，需要专用 `PROOFRUN_TEST_DATABASE_URL` 和建库权限。测试新建随机数据库，结束后删除；节点事件来自 `SimulatedNode`。

9 个业务场景通过；Node test runner 另外计入父测试，总计显示 10 个测试。

| 场景             | 已验证                                                                                        | 不覆盖               |
| ---------------- | --------------------------------------------------------------------------------------------- | -------------------- |
| 注册和权限       | Admin/Worker 分离、配对池绑定、一次性码、任务定义幂等                                         | 用户 SSO、多租户     |
| API 独占         | 同一数据库拒绝第二个活动 API                                                                  | PostgreSQL 故障切换  |
| 队列路由         | 65 个离线池任务不挡住在线池；排队预算耗尽                                                     | 生产规模吞吐         |
| 并发容量         | 两节点各一个容量，8 次并发领取不超配，关闭后继续队列                                          | 真实进程关闭         |
| 命令、证据和报告 | ID 幂等、不可变结果、PNG 摘要、证据归属、执行令牌仅能下载自己的证据、报告覆盖与聚合、完成幂等 | 页面结论是否正确     |
| API 重启         | 持久结果可查询，同一结果消息只归档一次，已完成动作不重执行                                    | 磁盘损坏             |
| worker 失联      | 到期撤权，未核实关闭继续占位，旧执行不能续期                                                  | 真浏览器租约退出     |
| 心跳锁顺序       | 心跳等待执行行时，命令外键检查仍可取得节点键共享锁                                            | 所有数据库故障和负载 |
| 未知写入         | MAY_HAVE_HAPPENED 结束本次执行，不允许换 ID 继续动作                                          | 引擎内部重试         |

## Linux 闭环：真实 Rust Node 与 systemd

入口：`pnpm test:control-plane:linux`。脚本创建独立 PostgreSQL 和 Linux systemd 容器、两台 Node 安装实例，执行后回收容器、匿名数据卷与网络。

使用真实 API、PostgreSQL、WebSocket、Rust Node、SQLite、systemd 用户服务及 cgroup v2；浏览器由 `tests/browser-node/fake_engine.py` 替代。该引擎会创建脱离 CLI 且忽略 SIGTERM 的后代，以验证真正的进程范围回收。

5 个场景：

1. 两个 Rust 节点真实配对，凭据文件 0600，标准输出不含机器密钥；三任务只能领取两个。
2. 完成动作后重启 API，相同命令请求返回原结果，假引擎写入计数仍为 1。
3. 真实 Node 上传夹具 PNG；下载 PNG 和 DOM 都能核对 SHA-256；正式报告存档后，仅关闭对应会话，另一会话进程仍存活。
4. 取消正在等待的命令，同时核实 API 关闭事实与后代 PID 消失，队列中的任务取得释放容量。
5. 假引擎写入后延迟响应，对 Node 主进程 SIGKILL；重启后关闭旧会话，任务 ERROR，写入次数仍为 1。

手动装配容器和完整一键脚本均已通过上述 5 个场景；完整脚本已验证从空数据库启动，结束后自动回收测试容器、匿名数据卷和网络。

这些结果不包含真实 Chrome、模型判断、生产 TLS 或真实内网 VM 的部署验收。原有 macOS Chrome 适配记录继续保存在 [Browser Node 验证记录](browser-node-validation.md)，两种测试范围不能合并描述为生产端到端验收。

## 工程检查与本轮修正

`pnpm check`、`cargo clippy --locked --workspace --all-targets -- -D warnings` 和 `pnpm build` 已通过。包括 8 个协议测试、9 个原有 Rust 可靠性测试、1 个新增文件锁释放测试；TypeScript 检查包含 API 测试代码。

本轮联调发现并修正三个问题：

- 批量 `FOR UPDATE SKIP LOCKED` 预先锁住整批任务，会让其他 worker 暂时误判空队列。改为按池有界取候选，再逐任务加锁。
- 节点事件使用 `FOR UPDATE` 时会阻塞命令外键的键共享锁，与执行行锁形成循环。节点主键不会改变，改用 `FOR NO KEY UPDATE` 保持节点事务互斥并允许外键检查，增加固定交错的回归测试。锁兼容关系见 [PostgreSQL 行锁文档](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS)。
- 文件句柄被复制时，关闭单个句柄不能立即归还目录锁。新增 `HomeLock` 守卫显式解锁，并用真实重复句柄复现与验证；Rust 对锁释放的说明见 [File 文档](https://doc.rust-lang.org/std/fs/struct.File.html#method.lock)。

## 后续验收

apps/agent 与 Console 均已接入。当前 14 个 PostgreSQL/HTTP/WebSocket 集成场景新增人工控制权与旧代次拒绝、配对回执恢复与凭据轮换、NETWORK 证据及同一登录状态独占调度、终态证据保留清理。真实模型与内网 VM 验收仍需单独开展。
