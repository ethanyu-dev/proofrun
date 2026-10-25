# Agent 决策循环与上下文简化架构

本文记录当前实现、删除边界和升级要求。新执行只有单一 LLM 路径；历史记录继续可读。

## 执行链路

```text
v2 请求 → 冻结 Case 与 executionPlan → 调度身份和节点租约
  → 创建临时浏览器 → 注入身份材料
  → profile-runner 编排分组与共享环境
      → runner 执行当前步骤
          → 更新预算、条件、观察与证据
          → context.ts 投影并裁剪唯一上下文
          → decisionPrompt + decisionTools
          → ChatModel：一次 HTTP 请求、一个工具调用
          → 校验并持久化 progress
          → 执行决定 → 刷新观察 → 下一轮
  → 完成业务与 cleanup → 关闭浏览器 → 释放账号和节点占用
```

`profile-runner.ts` 管分组、共享 setup 门禁、统一取消和最终报告；`runner.ts` 保留单一执行编排，调用 context、tools、workflow、criteria、operation-journal 等具体模块。未增加通用工作流引擎、第二个规划 Agent 或模型路由器。

setup 保留 PREPARING → CHECKING 两阶段。准备阶段的 finish 只表示准备声明结束，程序重新观察并核验身份、原始 policy 与固定 policyChecks；条件满足才允许业务验证。首个 setup 就绪后释放其他组，各组仍检查自己的条件。组内串行，组间沿用原并发约束；NETWORK/TRACE 的串行限制仍保留。

人工修改推进认证代次，旧确认和在途决定不得跨代次生效。人工交还后重新观察、重查条件，已发生的业务命令回执保留，避免重新提交。条件未满足时禁止误报业务通过；cleanup 继续使用独立预算与原环境门禁。

## 单轮决策

1. 同步取消、租约、控制权、认证代次和步骤预算。人工处理中暂停决策。
2. 取得当前有效观察，等待相关证据交付；计算阶段、条件、停滞及收尾状态。
3. 用白名单投影七个上下文模块；完成裁剪后，prompt 和 tools 读取同一个结果。
4. 保存实际请求，调用一次 Chat Completions，再记录响应与用量。适配器内没有 JEV 调用或隐藏重试。
5. 校验外层调用、工具及 progress。旧 plan/workflow/conclusions 入口明确拒绝。
6. 独立验证并保存合法进度；持久化失败则不继续动作。独立有效的验收结果不会因为后续动作参数错误而丢失。
7. 按当前权限、阶段、预算、目标与证据范围执行决定；真正派发时 API 再校验控制权与租约。
8. 浏览器操作后自动刷新观察。record 更新进度，finish 进入阶段或步骤结束校验。

协议错误按原预算进入下一轮纠正；未知副作用、撤权、取消和租约丢失仍停止。每轮至多一个模型工具调用；执行器必要的观察、取证和状态同步不是第二次模型决策。

## 唯一上下文

| 模块       | 当前组成                                                                                                    | 职责                       |
| ---------- | ----------------------------------------------------------------------------------------------------------- | -------------------------- |
| `task`     | 背景、当前步骤标识、description、policy、criteria、人工权限、原始 requirements                              | 本轮任务与固定要求         |
| `state`    | phase、settlement、criteria、带 scope 的 conditions、requirements 状态、readings                            | 已保存进度与准入事实       |
| `page`     | observationId、URL、标题、正文、documents、targets、tabs、viewport、atomic、network、artifactRefs、coverage | 当前可见证据和可操作目标   |
| `history`  | commands、omittedCommands、excerpts、omittedExcerpts                                                        | 已发生操作与有来源的旧正文 |
| `evidence` | 可引用附件的 id、kind                                                                                       | 工具证据枚举的唯一来源     |
| `budget`   | 剩余 actions、modelCalls、timeMs                                                                            | 硬额度                     |
| `feedback` | EXECUTION_FEEDBACK、OBSERVATION_STALLED、REPEATED_STATE 及相应消息/计数                                     | 当前异常和停滞提示         |

task 不透传内部 VerificationTask：账号材料、sessionPlan、调度节点、authState、comparison 元数据不进入循环。原始 requirement 文本放在 task.requirements，state.requirements 只保留对应身份、状态、摘要和来源。原 description/policy 保留，避免把要求拆分当作改写任务。前序步骤失败通过 feedback 进入下一步骤。

page.targets 保留真实浏览器操作能力，删除只服务对照匹配的 comparisonKey。history.commands 合并近期和关键回执，以 commandId 去重，保留发生顺序、operationStatus、effect、Cookie 清理结果等事实。历史正文剔除旧 target/ref 编号，不能据其重放动作；同时保留对应 documents/lang，语言声明不同的快照不合并。人工交接不清除重要副作用回执，步骤边界开始新作用域。

裁剪只修改投影副本：先移除旧历史片段，再收缩页面正文、阅读详情和目标表；同步标注省略与截断。已读身份保留，不能把被裁剪的已读项当作未读。固定任务、必要状态与关键回执仍超限时返回 CONTEXT_BUDGET_EXCEEDED，不能删掉要求再继续执行。字符预算不等同供应商 token 预算。

## 统一进度入口

所有模型工具共享可选 `progress`：

```json
{
  "progress": {
    "requirements": [
      {
        "id": "r1",
        "status": "complete",
        "summary": "已完成当前要求",
        "evidenceRefs": ["artifact-id"]
      }
    ],
    "criteria": [
      {
        "criterionId": "c1",
        "verdict": "PASSED",
        "summary": "观察到预期结果",
        "evidenceRefs": ["artifact-id"]
      }
    ],
    "readings": []
  }
}
```

模型 requirement 状态为 complete/incomplete/blocked；内部账本及 StepResult.requirements 使用 pending/recorded/incomplete/blocked，避免把模型声明当作程序证明。验收仍按原 criterionId 和媒介要求核验。readings 保存已观察面板身份和真实原文；需要重访时动作提供 revisitReason。

verification_record 必须有实际可保存内容，重复保存不会增加预算。PREPARING/CHECKING 不提供独立 record 工具，但其他工具仍可提交阶段范围内 progress。完成门槛保留原始要求与验收完整性；显式未完成/阻塞要求不能靠 finish 绕过。

API 持久化可选 StepResult.requirements，验证唯一要求身份、证据存在及 tab 归属，recorded 必须有引用。旧报告缺少该字段仍可读取。

## 工具与提示词

工具仍围绕 browser.act、observe、wait、cookies.clear，以及 verification.record、finish、block、intervene。实际集合由本轮阶段、人工授权、动作余额、收尾状态、观察和 Cookie 范围决定，未授权能力不提供给模型。verification.environment 已退出模型入口，环境来源由冻结的 executionPlan 决定。

预算收尾仅允许 record/finish/block，停滞收尾按执行状态限制；不提供新的浏览器动作或人工续时。视觉输入只受 LLM 的 vision 配置控制，没有 JEV 图片或 Box 旁路。

| 文件                         | 当前职责                                         |
| ---------------------------- | ------------------------------------------------ |
| `prompts/decision.ts`        | 公共任务、浏览器、证据规则，按阶段与收尾状态装配 |
| `prompts/tools.ts`           | 工具用途及证据引用说明                           |
| `prompts/recovery.ts`        | 当前使用的恢复反馈模板                           |
| `prompts/action-replay.ts`   | 人工交接后的防重放反馈                           |
| `prompts/settlement.ts`      | 收尾修复反馈                                     |
| `prompts/report-analysis.ts` | 报告复盘的独立请求                               |

工具机器协议仍由 Contracts 提供，Agent 的 tools.ts 收紧本轮能力与枚举、附加 progress，并覆盖模型用途说明。身份选择与报告复盘不是浏览器循环中的隐藏子调用。

## 删除清单

| 删除对象                                                                | 当前替代或保留边界                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------- |
| JEV HTTP 适配器、候选排序、图片/Box、复核与降级、FIELD_VALUE 子调用     | 单一 ChatModel 直接提出动作与填写值                     |
| model-router、legacy/guidance/planned-v1 切换和配置                     | 新任务只接受 llm；旧模式执行明确拒绝                    |
| plan、workflow.recovery、plan.inputs、inputFields、局部动作额度、检查点 | 原始要求账本、步骤硬预算、操作回执                      |
| executionGuidance、executionPolicy 模型块                               | 阶段状态、当前反馈；控制代次留在执行端                  |
| navigation-memory 的关键词与位置估算                                    | 有来源的历史原文；独立 scroll-distance 保留真实视口计算 |
| decision-view 二次投影与完整 observation 旁路                           | context.ts 唯一投影和裁剪                               |
| verification.environment 与模型环境分类                                 | 冻结 executionPlan；缺失必需计划则拒绝                  |
| conclusions、workflow.assessments、工具顶层 criteria 等模型别名         | 唯一 progress 入口；公开报告维持领域协议                |
| 旧计划/JEV/setup/页面通用大段 prompt                                    | 上述七个实际使用的提示词文件                            |
| 新建 JEV/双跑、Console 对照按钮、部署旧模式开关                         | 新建及重跑 llm；历史对照只读                            |
| 案例 HITL saveAuth/published、保存后重启和 tab 重建                     | 当前会话确认后直接交还控制权                            |
| profile_snapshots、版本竞争发布、基准复制、为保存合并 trace             | 临时浏览器正常取证与关闭                                |
| 登录状态导入/删除 CLI、默认模板自动回退                                 | 每次从明确身份输入材料建立会话                          |
| NodeProfiles 新建与 Console 模板维护交互                                | 新建返回 410；历史状态可读、遗留会话可关闭              |
| auth bindings 调度读写、authState 下发、基于基准的节点偏好              | 身份/显式路由约束和账号租约；节点要求 ephemeralProfiles |

这里的删除是架构收敛，不把所有旧机制都宣称为无用代码。无法说明收益的模型辅助视图不再长期维护同义副本；原始权限、预算和执行事实保留。

## 身份与 profile 生命周期

每个新会话创建临时浏览器目录，消费 Cookie 种子、已有登录配方或外部 DevPass 材料；当前 DevPass 支持 browser_cookies，没有新增完整目录下载协议。材料私密投递，种子消费后删除。访客不绑定账号。

人工处理只修改当前浏览器，不保存可供下一案例恢复的 profile，不发布新身份、不重启当前浏览器。下次任务重新获取材料；缺材料进入授权的人工/阻塞流程，不借用节点默认模板或静默切换账号。

以下内容保留：profilePlan/executeProfile 的分组编排、临时 user-data-dir、输入材料版本、身份选择、账号并发限制、authRevision、DevPass 硬到期、物理关闭后释放账号、StepResult 保存队列。它们分别有明确执行职责，不属于浏览器 profile 持久化。

旧数据库列、旧报告、历史模型调用用途和旧基准文件不做破坏性删除。兼容解码保留部分旧字段用于明确拒绝，不能恢复旧运行路径。browser.auth.save 返回退役错误，旧模板入口不再创建任务。

## 升级与验证

1. 停止旧 Agent 领取新任务，排空正在运行的旧会话。
2. Case 配置改为 llm，删除 JEV、执行策略和 base_profile_directory 配置；旧模式明确拒绝，不自动改写既有任务。
3. 协同升级 API、Agent 和 Node；新调度要求 ephemeralProfiles，旧 Node 不静默接单。
4. 只有人工基准、没有可重新注入材料的账号需补充身份来源。历史目录不会自动迁移成新材料。
5. 旧 JEV/双跑任务查看历史或创建新的 llm 运行，历史结果不被覆盖。

单元/HTTP/临时 PostgreSQL 回归验证上下文边界、阶段门禁、进度保存、未知副作用、租约、历史读取和退役接口。真实 Chrome 本地夹具验证逐轮填写、单次提交、观察，以及临时身份隔离和禁止保存。脚本模型和本地网页不代表真实供应商模型质量或生产业务验收；Linux/systemd 部署与真实模型效果需在对应环境验证。
