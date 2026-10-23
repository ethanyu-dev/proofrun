# Case 执行平台配置

本页面向部署维护者。上层调用方只使用 [Case API](public-api.md)，不选择环境、节点、登录态或预算。

复制 [case-profile.example.json](../deploy/case-profile.example.json) 到部署私有配置目录，替换环境和预算，设置 `PROOFRUN_CASE_PROFILE_FILE=/absolute/path/case-profile.json` 后启动或重启 API。应用不会自动加载 .env。

environment、budget、evidenceKinds 必填；executionMode 可选，默认 jev（LLM + JEV 单组），可显式选择 llm 或 parallel 双跑。默认模式需要配置 TYPESAFE_API_KEY。budget 保留既有配置文件结构并继续校验其范围，**v2 实际额度由下述逐步策略编译，profile 总预算不覆盖步骤额度。** evidenceKinds 为非空取证类型集合。配置错误时启动失败；未配置时新 case 返回 503 CASE_NOT_CONFIGURED，已有 v2 case 仍可查询、取消和幂等重提。

一套 API 当前绑定一份执行配置；待测入口由 case.entry 和各步骤 url 提供，不在平台配置中设置 target 或默认地址。调用方不能覆盖平台环境和执行策略。登录身份、节点能力、视觉 worker 和网络可达性须由部署方准备；配置结构校验不证明真实环境可执行。业务步骤的人工等待暂停计时，恢复只补回实际等待时间，模型和动作计数不清零；清理墙钟不暂停。

`/v1/cases` 已移除，历史任务快照继续保留供内部读取；旧配置文件不需要因入口移除而修改字段。Schema 与 OpenAPI 通过 `pnpm contracts:generate` 同步，`pnpm contracts:check` 检查漂移，服务升级需同时构建 contracts 与 API。

## 结构化 case v2

新版沿用同一平台配置，省略 executionMode 时默认创建 JEV+LLM 单组。显式 parallel 创建纯 LLM 和 JEV+LLM 两组，各自使用完整预算和独立会话；显式 llm 仅运行纯 LLM。新 v2 的 environment.reuseAuth 和 environment.allowIntervention 省略时均为 true，默认复用本站登录状态并允许人工辅助；部署方显式设置 false 时保留关闭。显式 `session.mode: "guest"` 仍按访客会话执行，不恢复登录。已有任务幂等重提不受默认值或部署配置变更影响。

新 v2 在接收时冻结 `stepBudget.version = 1`，API 与 Agent 使用相同额度：

| 阶段                        | 时间                 | 自动动作   | 实际模型请求        |
| --------------------------- | -------------------- | ---------- | ------------------- |
| setup                       | 五分钟               | 10         | LLM 20 / JEV+LLM 40 |
| verification                | 五分钟               | A          | LLM 2A / JEV+LLM 4A |
| 非 setup 且无验收项的纯等待 | 指定时长 + 30 秒取证 | 0          | 0                   |
| setup 或带验收项的等待      | 指定时长 + 五分钟    | 按步骤类型 | 按步骤类型          |
| 整段后续清理                | 三分钟墙钟，共享     | 10         | LLM 20 / JEV+LLM 40 |

verification 的 A = min(30, 12 + 2 × max(0, expected 项数 − 1))。其中两次基础动作供定位后选择、提交或查询使用，仍计入同一份冻结额度；例如 4 项验收为 18 次动作、LLM 36 次模型请求。按结构化项数分配，不根据模型自报复杂度增加额度。已有任务不自动扩容，沿用创建时的冻结值。

模型失败请求与重试均计数，自动导航占动作额度。步骤不能借用其他步骤额度；耗尽标为 BLOCKED，记录 `STEP_MODEL_BUDGET_EXCEEDED`、`STEP_ACTION_BUDGET_EXCEEDED` 或 `STEP_TIME_BUDGET_EXCEEDED`；共享首门禁未完成时跳过全部后续业务及清理，其他 setup 未完成只跳过本组验证并禁止清理，普通业务步骤则继续独立后续步骤。后续步骤仍核实自己的前置条件。无进展保护、单次调用超时、证据交付时限、上下文裁剪不随步骤数扩大。

已派发命令必须先确定效果，再推进下一步。每个业务步骤另预留最多两分钟用于在途调用、取证和结果落库，不能用来派发新业务操作。领取后才开始业务总安全时限，排队另受已有队列期限约束。节点 max_session_ms 必须覆盖业务、逐步收尾预留及清理；不足时明确显示 SESSION_BUDGET_UNSUPPORTED。节点默认一小时，长 case 需提高会话上限或拆分。会话预算超过一天、总动作超过 10000 或模型请求超过 20000 时直接拒绝，不削减后续步骤额度。

业务预算耗尽不会撤销整个 case。取消、租约丢失、节点断开或浏览器效果未知仍终止执行。清理失败或三分钟到期停止后续清理，清理结果不参与最终业务判定。

升级需一起更新 API、Agent、Console，并执行 API 启动迁移。只有声明 stepBudgetVersion=1 的 worker 能领取新任务，Node 协议未变化。历史运行中任务及相同 caseId 重提保持冻结快照；新身份重跑默认采用当前策略，`budgetMode: "original"` 可复现原预算。两组各自独立，JEV 需要 TYPESAFE_API_KEY。完整说明见 [v2 协议](public-api-v2.md)。
