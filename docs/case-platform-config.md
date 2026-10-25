# Case 执行平台配置

本页面向部署维护者。上层调用方只使用 [Case API](public-api.md)，不选择环境、节点、登录态或预算。

复制 [case-profile.example.json](../deploy/case-profile.example.json) 到部署私有配置目录，替换环境和预算，设置 `PROOFRUN_CASE_PROFILE_FILE=/absolute/path/case-profile.json` 后启动或重启 API。应用不会自动加载 .env。

environment、budget、evidenceKinds 必填；executionMode 可省略或设为 llm。新任务拒绝 jev 和 parallel，不再需要 TypeSafe 配置。budget.maxActions 和可选 timeoutMs 保留给旧版 `/v1/cases`：未指定时长时按每步五分钟计算，显式时长最多一天。**新建 v2 使用下述逐步策略，旧 profile 总预算不再覆盖 v2 步骤额度。** evidenceKinds 为非空取证类型集合。配置错误时启动失败；未配置时新 case 返回 503 CASE_NOT_CONFIGURED，已有 case 仍可查询、取消和幂等重提。

一套 API 当前绑定一份执行配置；多项目或多账号的上下文选择尚未实现。每次待测入口由 case.url 提供，不在平台配置中设置 target 或默认地址。调用方可以改变待测 URL，但不能覆盖平台环境和登录配置。登录身份、节点能力、视觉 worker 和网络可达性须由部署方准备；配置结构校验不证明真实环境可执行。新版业务步骤的人工等待暂停计时，恢复只补回实际等待时间，模型和动作计数不清零；清理墙钟不暂停。

此前配置文件中的 target 应删除；入口必须在 case 请求的 url 中提供。case.description 映射为内部任务的 objective，附带必要业务步骤。

旧版 case 在内部映射为 `case-<caseId>` 任务，并把原始业务定义与首次解析的配置一起保存在同一任务快照。重提原 case 不读取新配置，不重复执行；不同定义使用同一 caseId 返回冲突。原任务队列、报告校验、超时和清理机制保持复用，没有第二套运行时或新数据库表。

旧版公开响应只返回 CaseResult，不返回 VerificationTask、执行身份、登录配置、模型明细或清理进度。公开证据入口先检查该证据被本 case 报告引用；内部管理权限仍由现有管理员 token 管理，不是独立租户隔离。

Schema 与 OpenAPI 通过 `pnpm contracts:generate` 同步，`pnpm contracts:check` 检查漂移。服务升级需同时构建 contracts 与 API；单纯更新文档不会给旧服务增加 `/v1/cases` 路由。

## 结构化 case v2

新版使用单一 LLM 与临时 profile，身份来自选定的材料来源；`allowIntervention` 省略时为 true。`reuseAuth` 及旧槽位字段仅保留历史结构，不触发登录恢复或保存。显式 guest 从空白会话开始，环境意图在接收时冻结。旧报告和相同 caseId 的幂等读取保留；新重跑使用 LLM。

新 v2 在接收时冻结 `stepBudget.version = 1`，API 与 Agent 使用相同额度：

| 阶段                        | 时间                 | 自动动作   | 实际模型请求 |
| --------------------------- | -------------------- | ---------- | ------------ |
| setup                       | 五分钟               | 10         | 20           |
| verification                | 五分钟               | A          | 2A           |
| 非 setup 且无验收项的纯等待 | 指定时长 + 30 秒取证 | 0          | 0            |
| setup 或带验收项的等待      | 指定时长 + 五分钟    | 按步骤类型 | 按步骤类型   |
| 整段后续清理                | 三分钟墙钟，共享     | 10         | 20           |

verification 的 A = min(30, 12 + 2 × max(0, expected 项数 − 1))。其中两次基础动作供定位后选择、提交或查询使用，仍计入同一份冻结额度；例如 4 项验收为 18 次动作、LLM 36 次模型请求。按结构化项数分配，不根据模型自报复杂度增加额度。已有任务不自动扩容，沿用创建时的冻结值。

模型失败请求与重试均计数，自动导航占动作额度。步骤不能借用其他步骤额度；耗尽标为 BLOCKED，记录 `STEP_MODEL_BUDGET_EXCEEDED`、`STEP_ACTION_BUDGET_EXCEEDED` 或 `STEP_TIME_BUDGET_EXCEEDED`；共享首门禁未完成时跳过全部后续业务及清理，其他 setup 未完成只跳过本组验证并禁止清理，普通业务步骤则继续独立后续步骤。后续步骤仍核实自己的前置条件。无进展保护、单次调用超时、证据交付时限、上下文裁剪不随步骤数扩大。

已派发命令必须先确定效果，再推进下一步。每个业务步骤另预留最多两分钟用于在途调用、取证和结果落库，不能用来派发新业务操作。领取后才开始业务总安全时限，排队另受已有队列期限约束。节点 max_session_ms 必须覆盖业务、逐步收尾预留及清理；不足时明确显示 SESSION_BUDGET_UNSUPPORTED。节点默认一小时，长 case 需提高会话上限或拆分。会话预算超过一天、总动作超过 10000 或模型请求超过 20000 时直接拒绝，不削减后续步骤额度。

业务预算耗尽不会撤销整个 case。取消、租约丢失、节点断开或浏览器效果未知仍终止执行。清理失败或三分钟到期停止后续清理，清理结果不参与最终业务判定。

升级需一起更新 API、Agent、Console，并执行 API 启动迁移。只有声明 stepBudgetVersion=1 的 worker 能领取新任务，节点须声明 ephemeralProfiles。历史运行中任务及相同 caseId 重提保持冻结快照；新身份重跑默认采用当前策略，`budgetMode: "original"` 可复现原预算。旧 JEV/双跑不能按 original 预算复现，需按当前策略创建新运行。完整说明见 [v2 协议](public-api-v2.md)。
