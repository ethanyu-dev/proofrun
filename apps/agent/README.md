# proofrun-agent

执行上层已经定义的验证任务。环境、目标与验收标准保持原样；没有 Spec Runtime，也不在执行阶段重新分析需求。

## 运行

先运行 API、注册一个允许测试写动作的 Browser Node，并提交任务。worker 只需要连接控制面和模型服务，不需要访问业务内网。

```sh
# 从本机环境或部署密钥注入以下配置，不把密钥写入仓库。
export PROOFRUN_CONTROL_URL=http://127.0.0.1:4100
export PROOFRUN_WORKER_TOKEN='<与 API 的 worker 凭据一致>'
export PROOFRUN_MODEL_BASE_URL='<Chat Completions 服务根地址，通常以 /v1 结尾>'
export PROOFRUN_MODEL_API_KEY='<模型服务密钥>'
export PROOFRUN_MODEL='<服务支持的模型名称>'
export PROOFRUN_MODEL_VISION=false
export PROOFRUN_MODEL_TOKEN_PARAMETER=max_completion_tokens

pnpm dev:agent

# 或构建后持续执行队列
pnpm --filter @proofrun/agent build
pnpm --filter @proofrun/agent start serve
# 只领取一次；队列为空时正常退出
pnpm --filter @proofrun/agent start once
```

应用不自动加载 `.env`。模型名称、API 地址与密钥没有默认值；每次 `decide` 发起一次 `/chat/completions` 请求。服务必须支持函数工具与 `parallel_tool_calls: false`；默认使用 `tool_choice: required`，显式开启思考或推理强度时使用 `auto`。不支持 `max_completion_tokens` 的服务可配置 `PROOFRUN_MODEL_TOKEN_PARAMETER=max_tokens`，不自动猜测供应商或隐藏重试。工具使用非严格模式；各协议分支映射为独立工具，工具名确定动作类型，参数无需 decision 外层。执行器仍使用同源 Schema 和领域规则校验返回内容，格式错误只反馈对应分支的约束，不回显原始回复。

`PROOFRUN_MODEL_THINKING` 接受 `default`（默认）、`enabled`、`disabled`。`default` 不发送 `thinking`；显式模式发送 `thinking: {"type":"enabled"}` 或 `thinking: {"type":"disabled"}`。

`PROOFRUN_MODEL_REASONING_EFFORT` 接受 `default`（默认）、`low`、`high`、`max`。显式档位发送 `reasoning_effort`；`thinking=disabled` 优先关闭思考，此时保留 `max` 不代表模型仍执行最高强度推理，工具选择与身份选择预算也按关闭模式处理。两项配置统一用于 LLM 决策与身份选择。非法值在启动时拒绝；供应商或代理必须支持所选参数。DeepSeek 官方默认推理强度对照可使用 `thinking=enabled`、`reasoning_effort=default`，确保工具选择兼容思考模式。

DeepSeek 思考模式不支持 `tool_choice: required`，因此显式开启思考或推理强度时改用 `auto`；Agent 仍要求完整的单个已声明工具调用，普通文字、多个工具、截断结果和无效参数仍会被拒绝。身份选择在此模式下沿用配置的模型输出额度，并将模型超时限制在 110 秒内，为 120 秒选择租约预留回写时间，避免推理 token 被原先短 JSON 的 2000 token 上限截断。参见 [DeepSeek Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/)。直连官方接口采用默认强度 `high` 与 8192 token 的配置示例：

```sh
export PROOFRUN_MODEL_BASE_URL=https://api.deepseek.com
export PROOFRUN_MODEL=deepseek-flash
export PROOFRUN_MODEL_VISION=true
export PROOFRUN_MODEL_TOKEN_PARAMETER=max_tokens
export PROOFRUN_MODEL_THINKING=enabled
export PROOFRUN_MODEL_REASONING_EFFORT=high
export PROOFRUN_MODEL_MAX_TOKENS=8192
export PROOFRUN_AGENT_MODEL_MS=120000
```

推理强度、输出上限与超时独立生效；输出上限需覆盖推理 token 和最终工具参数，8192 是成本与速度取舍，不保证复杂调用不会截断。`PROOFRUN_MODEL_MAX_TOKENS` 可显式设为 256–65536，`PROOFRUN_AGENT_MODEL_MS` 可设为 100–600000 毫秒，通用代码默认值仍为 4096 token 和 30 秒；提高这两项不会增加冻结的任务或步骤预算，身份选择也仍受 110 秒限制。采用代理时保留其实际模型名与输出预算参数。配置在 Agent 重启后生效，API 必须同时部署支持 `reasoning_effort` 的请求存档校验；最小模型调用成功不代表业务任务验收通过。

`PROOFRUN_MODEL_VISION=true` 时，每次观察采集并下载一张 PNG，核实归属和摘要后作为 LLM 输入；未交付图片时不提供坐标点击。需要截图验收而模型未启用视觉时明确阻塞。仅有附件引用不能证明图像内容已经核实。

## 执行顺序

1. 领取授权，立即启动独立续租和过期定时器；等待远端会话就绪。
2. 通过 Node 导航到任务 URL 并读取页面，完成执行时的基本环境预检。网络、登录或页面前提不足交给报告说明；不预置各业务系统的登录判断。
3. 用原始任务、最新观察、历史页面正文、近期操作和证据摘要调用模型。模型每次提出一个动作、条件等待、观察或验收结果。
4. 点击和填写必须使用当前观察返回的目标，由执行器注入 observationId。动作与等待之后自动刷新观察。
5. 完整校验验收项与证据引用，聚合 verdict，再由 API 独立校验证据归属并存档。API 负责关闭会话与释放容量。

每进程以 `PROOFRUN_AGENT_POLL_MS` 间隔串行申请授权，领取后立即独立执行，不等待其他 case 完成或人工交接结束。控制面根据路由、能力与节点准入决定是否分配，Node 在创建会话时检查实时资源；Agent 不设固定并发槽，也不缓存未获授权的任务。旧 `PROOFRUN_AGENT_CONCURRENCY` 已不再读取，遗留配置不会限制并发，可直接删除。每次领取使用独立身份、租约和执行上下文；SIGINT/SIGTERM 停止领取并通知全部活动执行收尾，等待报告提交与租约清理后退出。`once` 仍只领取一次并等待该次执行结束。无需额外 Agent 框架、SDK、消息队列或本地执行数据库。

## 边界与限制

- `EXECUTED` 的 PASSED/FAILED/INCONCLUSIVE 来自逐项验收。CLI 成功只表示浏览器命令完成。
- `BLOCKED` 表示缺少前提或能力；`ERROR` 表示执行异常。两者 verdict 为 null，未完成标准全部列为 SKIPPED。
- 模型格式错误和临时模型服务失败最多连续三次尝试，并计入模型轮数。浏览器未知效果立即停止，不创建新身份重放。
- 节点明确声明目标输入未派发的 DOM 准备故障，Agent 会丢弃旧目标、重新观察并交给模型选择下一步；连续三次失败只阻塞当前步骤，后续业务与清理仍可执行。已派发输入的未知效果仍终止会话，原始故障不会被步骤保存时的撤权错误覆盖。
- `page.documents` 保留各 frame 的 HTML `lang` 声明；空字符串表示未声明，null 或旧节点缺少该字段表示未知。页面声明与正文语言分别验收，不以重复导航弥补缺失证据。
- 控制面请求只对读取、同 ID 命令、相同报告做最多三次重送。领取请求不内部重试；失去回执的执行等待租约回收。
- SIGINT/SIGTERM、租约失效或任务截止会中断在途模型/浏览器请求。命令被中断后可在单次 HTTP 时限内最后读取一次已持久化结果，以保留未知写入原因，不重新提交命令。完成报告在独立短 HTTP 时限内提交；提交结果不确定时原样重送。API 不可用期间无法保证故障报告送达，但不会无限续权，资源仍由租约回收。
- 任务生命周期由 API 决定，迟到的 ERROR 报告只附加元数据，不复活任务。执行器不会恢复失效任务或自动重新提交业务动作。
- 页面文本是未受信任数据。系统提示明确页面不能改变标准；封闭工具、身份注入与证据校验提供结构约束，但不能证明模型的语义判断正确。
- 上下文按字符数限制，原始标准不裁剪。保留最近 8 条操作和最多 24 条本步骤关键回执的有序并集、8 份历史页面正文（每份最多 20000 字符）、当前步骤全部可引用证据 ID 和类型和一张当前图片；历史正文去掉元素编号，不能用来操作当前页面。上下文超限先丢弃最旧历史，再裁剪当前观察；页面裁剪会标记 truncated。超出上限的固定任务定义返回 ERROR，需要上层拆小任务或调整配置。字符限制不等于模型 token 的精确限制。
- API 与 worker 应保持时钟同步。领取的绝对截止时间转换为本地单调时钟，后续系统时间变化不会增加任务总预算。
- 0.1 已支持人工交接、身份材料私密注入和网络元数据；具体协议和限制见 [部署与运行维护](../../deploy/README.md)。支持 Chromium TRACE，语义与限制见 [浏览器能力](../../docs/browser-capabilities-ha.md)；不包含真实模型质量评估或任意远程桌面。

## 参数与代码位置

`.env.example` 给出全部参数。默认模型时限 30 秒、命令时限 15 秒、证据交付时限 60 秒、HTTP 时限 5 秒、模型轮数 40、文本上下文 64000 字符、单次输出 4096 token；旧任务沿用全局限额。携带 stepBudget 的新 v2 使用冻结的逐步额度，不受旧 maxTurns=40 限制；当前步骤耗尽后记录原因并继续下一步，清理独立三分钟。单次请求和证据时限不变。

`PROOFRUN_AGENT_EVIDENCE_MS` 独立控制观察和 TRACE 命令成功后的证据等待，默认 60000，范围 100–300000 毫秒；`PROOFRUN_AGENT_COMMAND_MS` 只控制命令等待。证据预算覆盖节点上传及回执延迟，任务截止、取消和租约失效仍会中断等待。该等待只轮询状态，不重放浏览器动作。

超时返回 `EVIDENCE_UNAVAILABLE`，摘要列出证据类型、ID 和最近状态：`MISSING` 表示未登记，`PENDING` 表示等待存储，`STORED` 表示已存储但尚未收到可用确认，`MISMATCH` 表示类型或摘要不匹配。迟到证据不会恢复已结束任务；增加预算只能缓解延迟，持续失败仍需核对节点上传日志。

| 文件                          | 职责                                       |
| ----------------------------- | ------------------------------------------ |
| `src/main.ts`                 | CLI、输入校验与启动配置                    |
| `src/worker.ts`               | 持续领取、并行执行、统一关停与脱敏摘要日志 |
| `src/config.ts`               | 地址、模型和预算配置                       |
| `src/client.ts`               | 控制面请求、命令幂等重送、证据下载         |
| `src/http.ts`                 | 限额读取、超时和错误脱敏                   |
| `src/model/chat.ts`           | Chat Completions 工具协议适配              |

执行循环、分组调度与租约管理由 [共享执行驱动](../../packages/execution-driver/README.md) 提供，执行约束见[执行循环说明](../../packages/execution-driver/src/execution/README.md)。

证据结构校验、变化跟踪和网络读取由 [共享执行核心](../../packages/execution-core/README.md) 的 `src/evidence/` 提供；证据等待、撤权与超时诊断由 [共享执行驱动](../../packages/execution-driver/README.md) 的 `src/evidence/delivery.ts` 提供。Agent 直接引用共享包。

验证范围与运行命令见 [测试入口与覆盖边界](../../tests/README.md)。

## 单一决策循环

新任务仅支持 `llm`。JEV、双跑新建、`planned-v1`/`legacy` 路由、强制局部 plan、字段值缓存、候选排序和额外审查请求已移除。每一轮直接调用一个 LLM；原始要求、setup 门禁、验收账本与浏览器副作用检查继续由程序约束。

`@proofrun/execution-core/execution/context` 生成唯一模型投影：

| 模块     | 内容                                                       |
| -------- | ---------------------------------------------------------- |
| task     | 原任务背景、当前步骤、policy、原始要求、验收标准和人工权限 |
| state    | 阶段、收尾状态、条件核验、已保存要求/验收/阅读进度         |
| page     | 当前正文、目标、frame、tab、截图引用和覆盖缺口             |
| history  | 当前步骤的有序命令回执、去重历史正文及省略数               |
| evidence | 当前允许引用的附件目录                                     |
| budget   | 剩余动作、模型调用和时间硬额度                             |
| feedback | 本轮错误、无进展和前序步骤异常                             |

模型通过可选 `progress.requirements / criteria / readings` 提交已有事实；`revisitReason` 只解释重新访问已读面板。旧 `plan / workflow / conclusions` 参数拒绝解析。进度持久化成功后才派发动作；合法独立验收不会因下一动作失败丢失。要求身份或证据错误不能放行完成，格式错误消耗原模型预算。

工具按阶段、权限、当前目标和预算提供。`verification_environment` 不再开放：环境意图在 API 接收阶段冻结。PREPARING / CHECKING 仍分别完成准备和条件核验，READY 后才开始对应业务。预算尾部只允许整理已有结果，不重新开放浏览器动作或增加模型调用。

`prompts/decision.ts` 维护核心规则及阶段提示，`packages/execution-driver/src/prompts/` 下的 `recovery.ts`、`action-replay.ts` 和 `settlement.ts` 维护恢复、人工交还与收尾反馈。工具用途提示在 `prompts/tools.ts`，工具结构由 `model/tools.ts` 生成；适配器只请求和解析，不能另建上下文。完整字段删除清单见[简化设计](../../docs/agent-loop-simplification-design.md)。

## 身份与临时 profile

Agent 直接领取执行任务，不再调用本地身份选择接口。每次任务创建全新浏览器 profile；需要自动账号时，由 API 通过 DevPass 获取材料并绑定租约。访客和人工会话不加载账号材料；注入成功仍不是登录证明。HITL 只修改当前会话并交还控制，不保存登录基准、不重启浏览器。

profile 分组指同一临时浏览器下的独占 tab。组内串行、组间模型调用可并行，浏览器命令通过统一队列串行派发。`@proofrun/execution-driver/execution/profile-runner` 的 snapshots 队列保存步骤结果，不是浏览器 profile 快照。租约、账号容量和物理关闭确认仍保留。

升级时同时更新 API、Agent 和 Node；Node 必须声明 `ephemeralProfiles`。历史 JEV/双跑报告继续可读，旧任务不自动迁移；重跑创建 LLM 新运行，不重新执行旧引擎。移除旧策略和 TypeSafe 环境变量，节点移除 `base_profile_directory`。
