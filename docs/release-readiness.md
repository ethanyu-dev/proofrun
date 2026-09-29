# 首版发布检查表

首版暂按受控内网 Alpha 准备：单管理员、可信服务端调用方、限定业务场景、报告由使用方复核。项目版本号 0.1.0 不代表已经发布稳定版。开源许可证和公开分发范围尚未确定，不自动选择许可证或发布到软件仓库。

## 工程检查

```sh
pnpm install --frozen-lockfile
pnpm check
# 指向独立的测试 PostgreSQL；测试会创建并删除自己的数据库。
pnpm test:api
pnpm test:agent:integration
cargo clippy --locked --workspace --all-targets -- -D warnings
pnpm build
```

API 和 Agent/API 测试需要 `PROOFRUN_TEST_DATABASE_URL`。禁止使用业务数据库作为测试管理入口。CI 已配置独立 PostgreSQL 服务。

完整 Linux 检查使用 Docker 内的 systemd/cgroup 和 Chromium：

```sh
# Linux x64 使用 x64；Apple Silicon 的 Docker 使用 arm64。
node scripts/download-test-engine.mjs x64 .proofrun/bin/agent-browser-linux-x64
PROOFRUN_TEST_AGENT_BROWSER="$PWD/.proofrun/bin/agent-browser-linux-x64" \
PROOFRUN_TEST_FULL_LINUX=true pnpm test:agent:linux
```

下载器核对固定版本的 SHA-256，不替换已有不同内容的文件。完整检查包括 Agent/API/浏览器闭环、登录快照与网络元数据、systemd 生命周期、网关重连、DOM/Shadow DOM/iframe/TRACE 及人工介入。脚本只访问临时回环页面，模型为协议夹具；通过不代表真实供应商推理质量、业务写入故障或生产 VM 验收完成。

CI 两个任务均须通过。JavaScript Actions 运行在 Node 24；项目版本仍由 `.node-version` 指定。使用自托管 runner 时，需满足所固定 Action 的 runner 版本要求。不要通过允许不安全 Node 版本的开关绕过运行时升级。

## 2026-09-29 本地复验

- `pnpm check` 通过：协议 9、Agent 70、Console 21、Rust 19 项；完整构建和 Clippy 通过。
- 独立 PostgreSQL 的 API 测试 45 项通过；Agent/API 测试 11 项通过，包含节点长连接存在时正常退出的回归。
- 完整 Linux 入口通过：真实浏览器普通/Shadow DOM 表单、14 份摘要匹配证据、登录与网络、systemd 故障、网关可靠交付、原生 DOM 能力和 HITL。能力场景独立记录四次页面服务写入，HITL 记录一次提交；这些均为回环测试数据。
- 本机使用已有 arm64 Chromium/systemd 测试镜像，容器内按固定 Rust 1.98.0 从当前源码编译。未重建测试镜像，也未执行 GitHub 托管 x64 runner；远端 CI 状态仍需提交后确认。
- x64 引擎已完成新下载及 SHA-256 校验；arm64 已有资产的摘要校验通过，不匹配文件的拒绝路径已检查。下载器需要系统 curl。
- 本机在 Linux 全量 Rust 编译同时运行 API 测试时，曾出现 HITL 等待超时、TRACE 租约过期及 HA 连接终止错误；后续完成下述根因修复和并发回归。CI 分开运行 API 与 Linux 工作不能替代生产负载验收。

此前证据数量断言已改为媒介、引用和逐份摘要校验；本轮未复现旧的套件退出超时，也不据此宣称所有关停竞争均已消除。

### HA / HITL / TRACE 负载回归

这三类失败均定位到测试夹具，本轮未改变生产调度、4 秒测试租约或轮询超时：

- HA：修复前在独立的 PostgreSQL 17 容器（限制 1 CPU）上，每批 4 个进程、共 3 批的 12 次切换中失败 2 次。进一步追踪确认错误来自测试查询池：`pg@8.23.0` 的 `Pool.end()` 返回后，连接仍在断开，`DROP DATABASE ... WITH (FORCE)` 向它发送 `57P01`，引发未捕获错误。改用等待连接关闭的 `Client.end()`，并取消强制删库，让残留连接导致明确失败。
- HITL / TRACE：原夹具只发送节点心跳，领取任务后没有 worker 心跳；节点在线不能续期执行租约。加入跨越初始租约的确定性等待后，两条流程均失败，其中 TRACE 明确返回 `EXECUTION_EXPIRED`。补上独立 worker 续租，并在取消或完成前停止，清理时等待后台请求结束并报告续租错误。
- 回归覆盖：人工接管后跨越初始租约再断开重连；TRACE start 与 observe/stop 之间跨越初始租约。原有“不续租则过期、保留未核实容量、旧执行不能继续操作”用例保持原样。
- 修复后：同样的 1 CPU 数据库上，固定 3 批 × 4 进程的 HA 测试全部通过；随后 4 个并发进程各运行完整 API 套件，全部 45/45 通过（合计 180 项，包含父测试计数）。同时运行的 `pnpm check` 通过。没有按失败结果追加重试。

复验时将 `PROOFRUN_TEST_DATABASE_URL` 指向独立测试数据库。HA 使用 `pnpm exec tsx --test apps/api/test/ha.test.ts`，完整 API 使用 `pnpm exec tsx --test apps/api/test/*.test.ts`；按上述固定批次并发启动，每个进程单独保存日志并检查退出码。每个进程创建自己的随机数据库，不能复用业务库。

这些结果验证夹具在有并发竞争时仍遵守租约和关闭协议；本轮没有重跑真实 Linux 浏览器，也没有测得生产吞吐、延迟上限或持续负载容量。下方的业务、目标 VM 与故障验收仍未完成。

## 版本与交付

- 为拟发布源码建立 Git 提交，确认没有未纳入版本的必要文件；本机凭据、登录态和证据目录继续排除。
- 在该提交上完成检查，再创建明确的 Alpha 标签；保留提交 ID、构建环境、引擎版本、依赖锁文件和检查日志。
- 从干净检出重新安装和构建，按照部署文档启动；迁移 SQL 必须与 API 一起交付。
- 更新 CHANGELOG 的版本、日期、兼容范围和已知限制；只在真实发布后将条目移出“未发布”。
- 开源前由项目维护者确定许可证及第三方分发要求。`private: true` 与 Cargo 的 `publish = false` 保持不变。

## 业务验收

验收材料必须绑定源码提交、实际部署二进制摘要、模型名称与配置。逐个记录输入、原始证据、独立检查结果、总耗时和供应商 token 用量，保留失败与阻塞样本。

- 将每个必验结果列成单独验收项。结构化业务步骤可使用 Case API v2 的 check 步骤与 expected；不要用一条“下拉包含选项”代表所有弹窗、默认开关和清理要求均通过。
- 固定代表性场景及重复次数，分别报告通过、误报、漏报、阻塞与故障，记录耗时分布。先确定业务可接受门槛，再执行，不能只保留成功轨迹。
- 初次登录、登录过期、人工介入、虚拟列表、跨 frame、取消、超时和未知写入均须有对应场景。
- PASSED 必须有对应业务真值复核；COMPLETED、模型的步骤完成声明和证据摘要匹配均不能单独证明业务结论正确。
- 写操作的“业务已成功但引擎响应丢失”需要真实引擎故障注入和服务端独立计数。未完成前保留默认关闭与 `engineWritesVerified: false`，不通过修改布尔值宣布验收完成。

## 部署与恢复演练

在目标 Linux VM 使用普通运行用户，记录每项实际命令、预期和结果：

1. 干净安装并通过同源 HTTPS/WSS 连通性、配对、任务、证据下载和会话关闭检查。
2. 运行预先定义的并发与持续负载，观察队列等待、任务延迟、磁盘增长和关闭后残留进程。
3. 重启 API、Agent、节点及 VM；核对持久任务、未知效果、租约与容量。未知写入不得因恢复而重放。
4. 停止全部 API/Agent/Node 写入，成套备份 PostgreSQL、API 证据和节点 home；在隔离目标恢复到同一版本，核对历史报告、证据摘要、身份及登录快照权限。
5. 演练磁盘满、数据库中断和证据存储不可用；HA 部署还须演练实际入口及共享盘故障。
6. 升级前备份并留存原版本。数据库升级后不能仅切换旧二进制作为回滚；按已验证方案恢复同版本数据库、证据和节点状态。

这些项目需要指定 VM、业务环境和维护窗口。容器回归与模板文件不能把它们自动标为完成。
