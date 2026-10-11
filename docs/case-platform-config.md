# Case 执行平台配置

本页面向部署维护者。上层调用方只使用 [Case API](public-api.md)，不选择环境、节点、登录态或预算。

复制 [case-profile.example.json](../deploy/case-profile.example.json) 到部署私有配置目录，替换环境和预算，设置 `PROOFRUN_CASE_PROFILE_FILE=/absolute/path/case-profile.json` 后启动或重启 API。应用不会自动加载 .env。

environment、budget、evidenceKinds 必填；executionMode 可选，v2 默认 parallel，也可选择 llm 或 jev。budget.maxActions 和可选 timeoutMs 保留给旧版 `/v1/cases`：未指定时长时按每步五分钟计算，显式时长最多一天。**新建 v2 使用下述逐步策略，旧 profile 总预算不再覆盖 v2 步骤额度。** evidenceKinds 为非空取证类型集合。配置错误时启动失败；未配置时新 case 返回 503 CASE_NOT_CONFIGURED，已有 case 仍可查询、取消和幂等重提。

一套 API 当前绑定一份执行配置；多项目或多账号的上下文选择尚未实现。每次待测入口由 case.url 提供，不在平台配置中设置 target 或默认地址。调用方可以改变待测 URL，但不能覆盖平台环境和登录配置。登录身份、节点能力、视觉 worker 和网络可达性须由部署方准备；配置结构校验不证明真实环境可执行。新版业务步骤的人工等待暂停计时，恢复只补回实际等待时间，模型和动作计数不清零；清理墙钟不暂停。

此前配置文件中的 target 应删除；入口必须在 case 请求的 url 中提供。case.description 映射为内部任务的 objective，附带必要业务步骤。

旧版 case 在内部映射为 `case-<caseId>` 任务，并把原始业务定义与首次解析的配置一起保存在同一任务快照。重提原 case 不读取新配置，不重复执行；不同定义使用同一 caseId 返回冲突。原任务队列、报告校验、超时和清理机制保持复用，没有第二套运行时或新数据库表。

旧版公开响应只返回 CaseResult，不返回 VerificationTask、执行身份、登录配置、模型明细或清理进度。公开证据入口先检查该证据被本 case 报告引用；内部管理权限仍由现有管理员 token 管理，不是独立租户隔离。

Schema 与 OpenAPI 通过 `pnpm contracts:generate` 同步，`pnpm contracts:check` 检查漂移。服务升级需同时构建 contracts 与 API；单纯更新文档不会给旧服务增加 `/v1/cases` 路由。

## 结构化 case v2

新版沿用同一平台配置，默认同时创建纯 LLM 和 JEV+LLM 两组，每组均获得完整总预算和独立会话。省略 executionMode 或设置 parallel 开启双跑；显式 llm/jev 保留单组执行。旧 `/v1/cases` 继续单组执行，parallel 或省略模式时使用 llm。已有任务幂等重提不受默认值或部署配置变更影响。

新 v2 在接收时冻结 `stepBudget.version = 1`，API 与 Agent 使用相同额度：

| 阶段                                 | 时间                 | 自动动作 | 实际模型请求        |
| ------------------------------------ | -------------------- | -------- | ------------------- |
| 每个业务步骤（setup / verification） | 五分钟               | 10       | LLM 20 / JEV+LLM 40 |
| 无验收项的纯等待                     | 指定时长 + 30 秒取证 | 0        | 0                   |
| 带验收项的等待                       | 指定时长 + 五分钟    | 10       | LLM 20 / JEV+LLM 40 |
| 整段后续清理                         | 三分钟墙钟，共享     | 10       | LLM 20 / JEV+LLM 40 |

模型失败请求与重试均计数，自动导航占动作额度。步骤不能借用其他步骤额度；耗尽标为 BLOCKED，记录 `STEP_MODEL_BUDGET_EXCEEDED`、`STEP_ACTION_BUDGET_EXCEEDED` 或 `STEP_TIME_BUDGET_EXCEEDED`，继续后续步骤与清理。后续步骤仍核实自己的前置条件。无进展保护、单次调用超时、证据交付时限、上下文裁剪不随步骤数扩大。

已派发命令必须先确定效果，再推进下一步。每个业务步骤另预留最多两分钟用于在途调用、取证和结果落库，不能用来派发新业务操作。领取后才开始业务总安全时限，排队另受已有队列期限约束。节点 max_session_ms 必须覆盖业务、逐步收尾预留及清理；不足时明确显示 SESSION_BUDGET_UNSUPPORTED。节点默认一小时，长 case 需提高会话上限或拆分。会话预算超过一天、总动作超过 10000 或模型请求超过 20000 时直接拒绝，不削减后续步骤额度。

业务预算耗尽不会撤销整个 case。取消、租约丢失、节点断开或浏览器效果未知仍终止执行。清理失败或三分钟到期停止后续清理，清理结果不参与最终业务判定。

升级需一起更新 API、Agent、Console，并执行 API 启动迁移。只有声明 stepBudgetVersion=1 的 worker 能领取新任务，Node 协议未变化。历史运行中任务及相同 caseId 重提保持冻结快照；新身份重跑默认采用当前策略，`budgetMode: "original"` 可复现原预算。两组各自独立，JEV 需要 TYPESAFE_API_KEY。完整说明见 [v2 协议](public-api-v2.md)。
