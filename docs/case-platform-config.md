# Case 执行平台配置

本页面向部署维护者。上层调用方只使用 [Case API](public-api.md)，不选择环境、节点、登录态或预算。

复制 [case-profile.example.json](../deploy/case-profile.example.json) 到部署私有配置目录，替换环境和预算，设置 `PROOFRUN_CASE_PROFILE_FILE=/absolute/path/case-profile.json` 后启动或重启 API。应用不会自动加载 .env。

environment、budget、evidenceKinds 必填；executionMode 可选，v2 默认 parallel，也可显式选择 llm 或 jev。budget.maxActions 必填；省略 budget.timeoutMs 时，默认业务预算为 300000 毫秒 × steps 数量，无步骤的旧版 case 按一步计算。显式 timeoutMs 覆盖业务阶段预算，范围 1–86400000 毫秒。300 秒是每个业务步骤对业务预算的贡献，不是逐步独立的硬超时。进入 cleanup 后整段清理单独使用三分钟固定预算，重复上报、重启和人工暂停不会延长清理时间。evidenceKinds 为平台要求的非空取证类型集合。配置格式错误时启动失败，避免静默进入错误环境。未设置配置文件时，新 case 返回 503 CASE_NOT_CONFIGURED，已有 case 仍可查询、取消和幂等重提。

一套 API 当前绑定一份执行配置；多项目或多账号的上下文选择尚未实现。每次待测入口由 case.url 提供，不在平台配置中设置 target 或默认地址。调用方可以改变待测 URL，但不能覆盖平台环境和登录配置。登录身份、节点能力、视觉 worker 和网络可达性须由部署方准备；配置结构校验不证明真实环境可执行。人工介入由平台控制台处理，仍计入原预算。

此前配置文件中的 target 应删除；入口必须在 case 请求的 url 中提供。case.description 映射为内部任务的 objective，附带必要业务步骤。

旧版 case 在内部映射为 `case-<caseId>` 任务，并把原始业务定义与首次解析的配置一起保存在同一任务快照。重提原 case 不读取新配置，不重复执行；不同定义使用同一 caseId 返回冲突。原任务队列、报告校验、超时和清理机制保持复用，没有第二套运行时或新数据库表。

旧版公开响应只返回 CaseResult，不返回 VerificationTask、执行身份、登录配置、模型明细或清理进度。公开证据入口先检查该证据被本 case 报告引用；内部管理权限仍由现有管理员 token 管理，不是独立租户隔离。

Schema 与 OpenAPI 通过 `pnpm contracts:generate` 同步，`pnpm contracts:check` 检查漂移。服务升级需同时构建 contracts 与 API；单纯更新文档不会给旧服务增加 `/v1/cases` 路由。

## 结构化 case v2

新版沿用同一平台配置，默认同时创建纯 LLM 和 JEV+LLM 两组，每组均获得完整总预算和独立会话。省略 executionMode 或设置 parallel 开启双跑；显式 llm/jev 保留单组执行。旧 `/v1/cases` 继续单组执行，parallel 或省略模式时使用 llm。已有任务幂等重提不受默认值或部署配置变更影响。

升级已有部署时，删除 profile 中固定的 budget.timeoutMs，并删除 executionMode 或将其改为 parallel，才会使用新的默认行为；显式旧配置继续有效。JEV 组需要 worker 配置 TYPESAFE_API_KEY。

业务显式等待计入业务预算。结构化任务仅领取到会话硬期限能覆盖业务预算加三分钟清理预留的节点，70 分钟业务等待需同时提高 profile 预算和节点 max_session_ms。每组在原任务末尾执行清理，不另起任务或重新创建浏览器会话。默认业务时长为 steps 数量 × 300000 毫秒，显式 timeoutMs 覆盖业务阶段；清理从进入阶段起单独计时三分钟。动作和模型调用上限仍按整组累计。取消、超时或撤权后不再执行清理。历史已提交任务保留独立清理方式；不同 caseId 不因环境、登录上下文或站点相同而互相等待。完整说明见 [v2 协议](public-api-v2.md)。
