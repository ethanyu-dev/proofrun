# 浏览器能力与 API 高可用

本轮继续采用单一管理员 token 访问 Console，没有用户、SSO 或租户体系。Worker 和 Node 使用原有机器凭据，不能拿管理员 token 代替。API 可启动多个主备副本，其中一个持有 PostgreSQL advisory lock 并运行网关、调度器和 API，其余副本等待接管。

## DOM 与 devProof 对照

对照对象是同工作区 `devProof` 的 `docs/dom-visual-browser.md`、`apps/browser-runtime/src/dom-observation.ts` 和 `apps/agent-runtime/src/browser-tool-catalog.ts`，不将项目名称相同视为版本固定的公开产品承诺。

| 能力                   | ProofRun 本轮行为                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 无 ARIA 页面           | 从 Chromium 原生 DOMSnapshot 读取布局、可见正文、字段值与原生控件，识别 onclick、cursor:pointer、tabindex、contenteditable；不要求页面补 ARIA |
| Open/closed Shadow DOM | CDP 穿透开放、嵌套和关闭 shadow tree；目标绑定实际 backend node 与渲染会话                                                                    |
| iframe                 | 同源、跨域及嵌套跨进程 frame 采集与动作；通过父 frame 关系仅连接当前页的后代                                                                  |
| 条件等待               | CSS selector + text，在当前页或指定 frame 的 document / shadow roots 中轮询；跨域和 closed roots 同样可读                                     |
| 元素身份               | 每次观察独立 ID，动作后作废；节点被同名节点替换时返回 STALE_OBSERVATION，不重找并点击替代节点                                                 |
| 输入与选择             | fill、type、click、hover、check、uncheck、原生 select；自定义下拉框通过点击并重新观察处理                                                     |
| 导航与页面             | navigate、back、forward、reload、resize、tab.new/switch/close；tab ID 来自观察；frame 切换观察范围                                            |
| 视觉输入               | 截图关联当前观察，视觉模型可用 visual.click；检查视口、URL、滚动位置、有效期与坐标，纯文本模型不能发视觉点击                                  |
| TRACE                  | 导航前开始、报告前停止、可靠上传、SHA-256、报告引用、Console 下载                                                                             |

上述 DOM / Shadow DOM / iframe 核心能力对齐了参考项目，closed DOM 直接读取超出其文档中的视觉回退方式。此表不是对 devProof 整个工具目录的全面兼容声明：独立的诊断命令、网络故障注入、拖拽和批量填表尚未逐项迁移。新页面控件、复杂遮挡和特定框架仍需实测，不能从本地夹具推断所有网站均通过。

观察带 `truncated`，超过正文 200 KB 或目标 2000 个时明确裁剪；裁剪不能用来证明页面内容不存在。模型上下文按任务相关片段保留长页首尾及相关正文，避免前缀裁剪提前删除页尾证据。页面数据始终是证据，不授予执行任意 JavaScript / CLI / shell 的权限。

## 单一共享登录配置

沿用现有 `env.auth` 绑定，所有需要登录的任务统一使用同一个节点和 `stateId: "shared"`。首次人工登录设 `restore:false` 并在 HITL 保存状态，后续设 `restore:true`。不需要账号、用户或租户模型。

这里共享 Cookie / localStorage 登录快照；每次执行仍生成独立临时 Chromium profile，避免多个 Chrome 进程同时写同一 profile 导致锁冲突或数据损坏。同一个登录槽在前一个会话确认关闭后才分配下一次执行。登录操作与配置示例见 [登录复用](migration-completion.md)。

## TRACE 语义

任务验收项 acceptanceCriteria[].evidenceKinds 加入 `TRACE` 后，只调度到声明 trace 能力的节点。Agent 在业务导航前启动采集，报告前停止并等待 AVAILABLE，再把实际引用加入要求 TRACE 的验收项。阻塞和执行错误在仍持有执行权时尽力结束采集；超时、撤权、浏览器崩溃或被强杀不能保证输出完整 trace。

文件是 Chromium JSON timeline，可导入 Perfetto / Chrome Trace Viewer。采集类别包括 devtools.timeline、v8.execute、blink.user_timing、loading 和截图，覆盖采集期间浏览器活动；不是 Playwright trace.zip，也不包含模型思考、全部请求响应体或所有系统事件。命令及结果另存于执行记录。

采集不使用循环覆盖缓冲；Chromium 报告数据丢失、文件超过 64 MiB 或 spool 额度不足时明确失败，不能以截断文件宣称完整。单个文件上限 64 MiB，节点总体 spool 默认 256 MiB。上传为 `application/vnd.proofrun.trace+json`，下载为 JSON；节点 outbox 与 API 校验沿用可靠截图交付机制。TRACE 可能含页面正文、URL 和截图，访问控制与其他证据一致；不要把它当作已脱敏的 NETWORK 元数据。

## API 主备部署

每个副本设置 `PROOFRUN_API_HA=true`。所有副本使用同一数据库、管理员/Worker 密钥、PUBLIC_URL 和**同一共享证据目录**。跨主机部署需要可靠共享文件系统；仅复制目录路径字符串并不会共享文件。PUBLIC_URL 指向负载均衡入口，Node 与 Agent 始终连接这个入口。

同机演练可分别设置 API_PORT=4101 / 4102，复制 [Caddy HA 模板](../deploy/Caddyfile.ha)，并设置 PROOFRUN_DOMAIN。跨主机把 PROOFRUN_API_A / PROOFRUN_API_B 换成副本内网地址。Console 静态文件由入口统一提供。

- `/health/live`：进程存活，备用实例也返回 200。
- `/health/ready`：仅健康活动实例返回 200，备用实例返回 503；负载均衡按此摘除和加入。
- 锁连接每秒探测，查询等待最多两秒；连接错误或超时撤销就绪并关闭网关。备用副本每秒尝试接管。
- HTTP / WebSocket 都转发到当前进程的活动控制面。切换时旧 WS 断开，节点通过入口重连；提交的任务、租约、命令和证据登记保留在 PostgreSQL。
- 对未知效果的浏览器写入保持原有保守语义，不以 HTTP 自动重试或切主为理由重放动作。切换并不保证当前任务无感继续；租约过期时按既有规则中止并回收。
- 证据维护时停止**全部** API 副本，避免备用立即接管；升级也需保持数据库版本兼容。

这是 API 进程的主备高可用，不提供 PostgreSQL、共享盘或负载均衡器自身的高可用。生产应分别保证这些依赖的故障切换。当前为单活动网关，不是同时负载分担的 active-active 架构。

## 验证范围

`tests/browser-node/capabilities_smoke.py` 在 Linux Chromium 和固定 agent-browser 0.38.1 上，以独立 session-host、临时 profile 和本地页面验证真实 DOM / shadow / iframe 动作、服务端四次写入、失效节点拒绝、视觉点击、标签页和 TRACE 文件。不覆盖生产内网、业务登录、VM 重启、模型任务完成率。

`apps/api/test/ha.test.ts` 启动两个真实 HTTP/WS API 入口，共享临时 PostgreSQL 数据库，验证单一就绪实例、WS 节点接入、持锁连接被终止后的接管与任务持久化。TRACE 集成测试验证权限、内容类型、摘要、可靠可用登记和下载。生产跨机网络分区、真实负载均衡与共享盘故障仍需环境演练。

2026-09-28 本地结果：`pnpm check` 通过（9 个协议、38 个 Agent、5 个 Console、16 个 Rust 测试）；API 20 个测试、Agent/API 8 个集成测试、Linux systemd/gateway 回归与真实 Chromium 能力回归通过；Console 生产构建和 Rust clippy 通过。真实能力回归使用 4 次服务端业务写入核对四类 DOM 容器，TRACE 得到 13,586 个事件；数量仅描述该次夹具运行，不是覆盖率指标。

主备探针配置依据 [Caddy reverse_proxy 官方文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#active-health-checks)；跨进程关联使用 [Chromium Target 协议](https://chromedevtools.github.io/devtools-protocol/tot/Target/) 的父 frame 关系。
