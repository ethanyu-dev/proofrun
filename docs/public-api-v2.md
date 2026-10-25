# 结构化 Case API v2

`POST /v2/cases` 支持请求对象封装和兼容数组；cases 中每个对象是一个独立 case，默认创建 LLM 单组任务，旧 jev/parallel 不再接受。不同 caseId 可按平台容量并行执行；每个对象是独立 profile 维度；内部先按 `exec_order` 稳定排序，再以 setup 拆成独占 tab 的分组，最多八个组并发、组内串行。不同账号或有冲突的环境应放在不同对象，存在先后依赖的步骤放在同一分组。不会为每个步骤创建独立任务。

旧 `/v1/cases` 单 case 接口继续保留。新旧请求格式不混用；内部 `/v1/tasks` 不接收新版 case、结构化步骤或清理任务，也不支持从内部入口对它们自动重跑或追加双组对照。重新执行可使用下述 case 重跑接口，或通过新版提交接口提交新的 caseId。

查询结果包含可选的 `queueReason: { code, message } | null`，供排查任务为何尚未开始。它记录最近一次领取检查遇到的配置冲突、资源占用或节点不可用等原因；成功领取后清空，取消或排队超时后保留。null 或字段缺失表示尚无诊断，不保证节点可用。排队超时不代表业务验收失败，业务结果仍以实际执行报告为准。

## 请求归属与汇总报告

需要按一次提交关联多个 case 时，`POST /v2/cases` 使用对象封装：`{ "requestId": "release-01", "title": "邀请活动回归", "cases": [...] }`，`cases` 内仍是原有完整 case 定义。完整夹具见 [请求示例](../contracts/examples/public-api/request-v2.json)。对象格式返回 `202 RequestResultV2`；旧数组格式及其 `CaseResultV2[]` 响应保持不变，旧数组不会推测请求归属。

requestId 必填，为 1–80 位字母、数字、下划线或短横线；title 可选，提供时为 1–200 字符非空白文本，省略则显示 requestId。每个请求仍限 1–32 个 case、2 MiB，不允许重复 caseId 或未知顶层字段。请求与新任务、两组执行的归属在同一事务创建；任一冲突不会留下部分新增任务。

同 requestId、同定义重提返回已有请求的最新结果。cases 重排不改变请求身份，展示顺序保持首次接收值；更改标题、成员或 case 定义返回 `409 REQUEST_CONFLICT`。case 内数组保留原有顺序敏感规则。不同 requestId 引用相同 caseId 和定义时复用已有执行，成员的 executionOrigin 为 reused，显示原执行时间；这不表示重新验证。同 caseId 不同定义仍返回 `409 CASE_CONFLICT`。

- `GET /v2/requests`：请求摘要列表，支持 q、executionStatus、reportStatus、limit（1–100，默认 25）及 cursor。q 按请求身份、标题、case 身份或目标搜索；命中一个成员仍返回整个请求的统计。游标绑定筛选条件，不能更换筛选后沿用。
- `GET /v2/requests/{requestId}`：请求元数据、全部成员、冻结的步骤、各组进度和汇总。
- `GET /v2/requests/{requestId}/report`：相同一致性快照的汇总报告，包含 case 矩阵、逐项两组结论、证据引用与清理情况。
- `POST /v2/requests/{requestId}/rerun`：接收 `caseIds: [{ sourceCaseId, runId }]` 和可选 budgetMode/timeBudget。默认保留原 requestId，可选一个或全部成员，在一个事务内新增运行并切换所选成员的报告；未选成员及其他请求不变。旧运行和证据保留，新运行进行中不回退旧结果，旧 Agent 分析失效。重试沿用完整映射及预算；成功后再次重跑必须更换 runId，旧操作重试不会回退最新结果。同一 runId 改变参数或被其他操作占用返回 409 CASE_CONFLICT。旧映射字段 caseId 兼容解释为运行幂等键。兼容旧客户端显式提供新的 requestId，此时必须覆盖全部成员，创建独立请求；相同新 requestId 参数改变返回 REQUEST_CONFLICT。

请求的 executionStatus 为 QUEUED / IN_PROGRESS / FINISHED，只表达执行进度；reportPhase 为 PENDING / PARTIAL / FINAL。所有要求组终止后为 FINAL，即使有子报告缺失。非 FINAL 的 reportStatus 为 null；已交付报告中的失败仍由 observedFailureCount 显示。FINAL 时，任一组已确认 FAILED 则汇总 FAILED，所有要求组均 PASSED 才 PASSED，否则 INCONCLUSIVE。两组相反的明确判断另计 confirmedDisagreementCount，不能将组间差异直接解释成产品根因。

uniqueCriteriaCounts 按 `(caseId, criterionId)` 统计一次，包含 total、passed、failed、inconclusive、skipped、pending，后五项之和等于 total；双跑不会把总数翻倍。确认失败优先；否则仍有组未终止计 pending；终止后全部通过计 passed，全部缺失/未验收计 skipped，其余计 inconclusive。请求整体结论还检查完整单组 reportStatus，不能只凭验收项统计推断前置步骤已完成。setup 的显式 expected 保留，policy 不计入，cleanup 单独展示。

reportCoverage 的 expected、available、missing 明确报告齐全程度；byExecutionMode 分别统计 LLM/JEV 已交付报告，不把未配置模式当成缺报告。响应携带 generatedAt 与 aggregationVersion（当前为 1），页面和 JSON 导出使用同一份服务端快照；部分导出明确标记 partial。清理失败不改变已确认业务通过，证据清理不改变已有结论。

Console 的任务和报告默认按请求展示，提供未归组任务、全部执行明细以及原 taskId 深链接。共享 case 的执行详情列出所有关联请求，取消会影响所有引用同一执行的请求。请求内单 case 重跑向请求重跑接口提交仅含该成员的映射；整体重跑提交全部成员。报告使用各成员当前运行的结果。独立 `/v2/cases/{caseId}/rerun` 仍只新增运行，不推测要更新哪个请求。请求分组不改变调度、浏览器会话或 case 间依赖关系。

## 提交与身份

请求样例见 [cases-v2.json](../contracts/examples/public-api/cases-v2.json)。示例地址、账号和恢复值为夹具，需要上游替换，不代表真实业务验收。

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $PROOFRUN_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @cases-v2.json \
  "$PROOFRUN_CONTROL_URL/v2/cases"
```

使用兼容数组格式时，返回 202 和与输入顺序一致的结果数组；请求对象格式返回请求汇总对象。批次限制为 1–32 个 case，请求体仍受 2 MiB 限制。整批校验和事务接收，格式错误或任一身份冲突时不留下部分新任务。不同请求允许重叠 caseId；相同原始定义幂等返回已有结果，不重复执行。steps 的原始排列以及 policy/expected 的顺序属于该 case 定义的一部分；批次中的 case 排列不改变各自的幂等身份。

| 字段        | 约束与含义                                                                    |
| ----------- | ----------------------------------------------------------------------------- |
| caseId      | 必填；1–80 位字母、数字、下划线或短横线。同身份不同定义返回 409 CASE_CONFLICT |
| platform    | 必填业务标签，不用于猜测账号或选择执行环境                                    |
| entry       | 必填 HTTP(S) 站点入口，步骤使用自己的 url 导航                                |
| description | 可选的任务背景，不替代逐步骤定义                                              |
| steps       | 必填，1–32 项；至少一个 verification                                          |
| cleanup     | 必填，0–32 项；空数组表示未声明业务清理，并不保证没有副作用                   |

每一步的字段：

| 字段        | 约束与含义                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| stepId      | 可选，1–80 位安全字符；省略时按原数组位置生成 step-1、step-2 等，排序不改变身份。包含自动身份在内必须唯一 |
| type        | setup 或 verification                                                                                     |
| url         | 必填 HTTP(S) 操作入口，不是导航白名单                                                                     |
| exec_order  | 必填，1–1000000 的整数；可不连续、可重复                                                                  |
| description | 必填操作说明                                                                                              |
| policy      | 必填字符串数组；本步骤的操作约束，允许为空                                                                |
| expected    | 必填字符串数组；逐项验收标准。setup 可为空，verification 至少一项                                         |
| wait        | 可选的显式等待配置：`{"durationMs":4200000}`。等待期间占用原会话并计入总预算                              |

文字字段不接受纯空白，说明和数组中的字符串最多 2000 字符，policy/expected 各最多 32 项。每条 expected 的 criterionId 是 `<stepId>-expected-<原始位置+1>`，结果按此身份关联。自然语言 policy 保留原文进入模型上下文。可选 policyChecks 将指定条件绑定到固定检查，不增加 expected 或业务验收项。

新任务的 setup 分为 PREPARING（执行 description 的准备操作）、CHECKING（强制核验原始 policy 与显式身份条件）、READY。准备阶段允许浏览器操作；操作完成声明只触发检查，不直接放行业务。检查不会从 description 增加条件，也不会把被测产品的资格提示当成账号角色矛盾。空 policy 仍经过新观察及显式身份条件校验。

新计划第一次缺少完成声明时返回缺项反馈，允许在原预算内修正；再次缺失则记录 SETUP_EVIDENCE_INCOMPLETE。固定检查缺少采集、范围或响应证据时记录 POLICY_EVIDENCE_INCOMPLETE，不自动转 HITL，也不允许人工勾选代替网络事实。需要人工操作的环境问题仍按具体未解决条件交接，每个条件在同一认证版本只交接一次，每组总共最多三轮。交接暂停整个 profile；只有处理页逐项提交才形成确认。纯查看和控制权切换保留身份确认；输入、导航、Cookie 或认证准备改变 authRevision 后重新核实身份及其他 tab 的 policy。管理员直接恢复不代表确认环境。

仍未就绪时记录 BLOCKED / `ENVIRONMENT_NOT_READY`，本组后续 verification 为 SKIPPED，其他 setup 分组继续执行。任一组环境未就绪时禁止 profile 的全部 cleanup；浏览器资源仍由控制面关闭回收。执行故障保留原始分类，准备或环境重查未完成同样不能放行本组验证和 profile 清理。历史冻结任务没有 profilePlan 时保持原来的整链门禁。

步骤的可选 `blockage` 保存具体未解决条件、冻结时刻和当时证据引用；截图不可用时保留 `screenshotError`，不会覆盖原阻塞原因。API 校验证据归属并禁止替换已保存快照。Console 单组及对照组终态优先展示阻塞截图；旧报告只回退到同一步证据，不用 cleanup 最后一帧代替。清理截图在「后续清理」中单独展示。

setup 通过后，普通 verification 步骤的 FAILED/INCONCLUSIVE、BLOCKED 或局部 ERROR 仍会记录后继续尝试独立后续步骤；每一步核实自身必要条件。取消、超时、租约失效或未知写入撤权会停止整个任务。步骤 COMPLETED 表示完成执行和结论交付，不等于普通业务验收项全部通过。

## 冻结环境与证据计划

新提交和重跑的 case 在 session.open 前生成 executionPlan.version=1。显式 session 优先；未指定时，仅从 setup 的 description/policy 识别无否定、无引用、无条件语气的明确访客要求。依据保存在 environment.basis，source 为 explicit / inferred / default。不能明确判断时保留 manual；明确的访客与已登录要求或显式非访客 session 冲突，返回 422 ENVIRONMENT_CONFIG_CONFLICT。此解析是保守规则，不覆盖任意自然语言；需要确定行为时显式写 `"session":{"mode":"guest"}`。

访客会话不恢复也不保存登录槽。节点回执提供绑定 sessionId 的 environmentProof；缺失或显示曾恢复登录状态时，执行器报告 ENVIRONMENT_PROOF_MISSING，模型声明不能替代准备证明。没有 executionPlan 的历史冻结任务保留原结构，读取不会迁移；新执行仍不支持旧引擎或本地登录快照；重跑是按新规则编译的新任务，可能需要解决原定义中的环境冲突。

步骤及 cleanup 可配置 policyChecks，id 在步骤内唯一，policyIndex 是原 policy 的零起始索引。同一 policy 的多个检查必须全部满足。例如：

```json
{
  "policy": ["活动接口返回成功"],
  "policyChecks": [
    {
      "id": "invite-response",
      "description": "邀请活动接口响应成功",
      "policyIndex": 0,
      "method": "networkResponse",
      "path": "/v1/activity/invite-activity-info",
      "statusMin": 200,
      "statusMax": 299
    }
  ]
}
```

networkResponse 只接受步骤 URL 同源、当前 tab 当前主文档导航的指定 path 和状态码；不读取请求或响应正文。跨域接口需另行扩展契约。原要求只需页面呈现时，可明确使用 `method: "renderedContent", text: "原要求中的可见文案"`；不会自动降级接口要求。未观察到请求为 UNCONFIRMED，观察到不匹配状态码才为 UNSATISFIED，两者均不能宣称业务失败。

executionPlan.evidenceKinds 是验收取证配置与全部步骤（含 setup、cleanup）固定检查的并集。调度器只分配给支持计划版本和所需证据的 worker/节点，能力不足继续排队。步骤 environmentHistory 保留处理原因及版本，身份结果记录 source 与 authRevision。

## 等待与平台配置

明确时长请填写 wait.durationMs；仅在 description 写“等待一小时”不具备确定性计时语义。计时由 Agent 完成，不循环调用模型；期间续租、检查取消，等待完成后重新观察页面。纯等待步骤不主动导航至 url，保留现有会话上下文；setup 等待结束后仍须核实完整准备要求并提交证据，因此保留正常步骤的动作与模型额度；带 expected 的等待也继续观察与验收。

显式等待自动计入本步额度：无验收项使用等待时长加 30 秒取证，不调用模型；带验收项在等待时长上另加五分钟。领取后才启用业务预算，排队不扣减步骤额度。

新 v2 每个业务步骤独立五分钟。准备步骤为 10 次动作、20 次模型请求；验证步骤为 12 次动作（包含两次定位后选择、查询的收尾额度），每增加一项验收再增加两次动作，最多 30 次。验证模型请求额度为动作额度的两倍。新规则只在创建时编译，既有任务沿用冻结额度。步骤不能互借额度，耗尽后记录 BLOCKED 和具体原因；普通业务可继续独立后续步骤，setup 未完成则跳过本组后续验证并禁止 profile 清理。旧 profile 总预算只用于旧版 case。cleanup 整段独立三分钟、10 次动作和 20 次模型请求，业务耗尽不侵占它的额度。人工等待暂停业务计时，恢复剩余额度，不清零计数；清理墙钟不暂停。每个业务步骤另预留两分钟供在途调用和取证落库，不能用于派发新操作。取消、租约丢失、未知浏览器效果仍终止执行。

节点默认会话硬期限为一小时，必须覆盖全部业务、逐步收尾预留和清理；不足时排队原因显示 SESSION_BUDGET_UNSUPPORTED。会话预算超过一天的 case 直接拒绝，不削减后续步骤额度。长 case 需提高 max_session_ms 或拆分。请求不接受自定义预算或模式，详见[平台预算规则](case-platform-config.md)。

本版不支持挂起释放会话，也不支持 worker 重启后从中间步骤继续。步骤结果已经持久化；失联仍按原租约规则结束任务，不能盲目重放可能产生副作用的动作。

## 查询与结果

`POST /v2/cases/{caseId}/rerun` 接收 `{"runId":"本次运行的幂等键"}`，返回 202 和同一 case 的单个 `CaseResultV2`，其中 caseId 不变，taskId/runId 指向新运行。沿用原业务定义、环境和取证类型，新运行统一使用 LLM，默认按当前逐步预算策略生成新任务；可传 `budgetMode: "original"` 复现原预算，缺省为 `"current"`。不复制旧状态或报告。历史双跑只创建一个新的 LLM 运行；旧 JEV/双跑使用 original 预算时返回 RERUN_BUDGET_INCOMPATIBLE。平台配置撤下后仍可重跑；如需采用当前环境配置，改用 `POST /v2/cases` 提交新身份。

可额外传 `timeBudget: {"stepTimeoutMs":900000,"cleanupTimeoutMs":600000}`，在所选预算基础上将每个业务步骤至少扩展到 15 分钟、整段清理至少扩展到 10 分钟。两个字段可单独提供，值必须为正整数毫秒；原本更长的步骤（包含等待）不会缩短。动作数、模型请求数及收尾额度不变，业务总时间重新汇总，完整会话仍受 24 小时上限约束。没有逐步预算的历史任务会在新身份上补编译逐步计划。相同 runId 重提始终返回首次冻结的预算；改变额度需要另一个新 runId。

runId 为 1–80 位字母、数字、下划线或短横线，与 caseId 使用独立命名空间。相同 runId 的重试返回已存在运行，不再执行；其他 case 占用该运行身份时返回 409 CASE_CONFLICT。旧 caseId 请求参数兼容作为 runId，但不能同时传入两个字段。除上述时间下限外，请求不接受其他预算或步骤覆盖。Console 请求详情的“重跑此 case”使用请求重跑接口，并留在原请求页刷新；不会将单个 case 的新执行放入另一个请求。

- `GET /v2/cases/{caseId}`：读取最新未删除运行的状态、逐步结果和清理状态；可通过 `?runId=返回的运行身份` 指定历史运行。
- `GET /v2/cases/{caseId}/runs`：按时间倒序读取未删除运行，旧记录自动作为首轮运行。
- `POST /v2/cases/{caseId}/cancel`：取消该 case 的所有执行组，同时停止尚未执行的清理。历史独立清理任务保留旧语义。
- `GET /v2/cases/{caseId}/evidence/{artifactId}`：读取指定运行的步骤记录、报告或关联清理报告引用的证据；历史链接携带 `?runId=运行身份`，避免最新运行改变证据归属。

所有接口沿用部署管理员 Bearer 凭据。结果结构见 [CaseResultV2 Schema](../contracts/schemas/case-result-v2.schema.json) 与 [OpenAPI](../contracts/public-api.openapi.json)。

响应包含 caseId、status、reportStatus、criteriaCounts、result、steps、cleanup。历史双跑额外返回 `comparison: { id, arms }`；arms 按 llm、jev 顺序分别包含 taskId、executionMode 和各自的完整 case 结果（含步骤、清理及排队原因）。顶层字段保持纯 LLM 主组的原有投影，不能用顶层完成或通过推断另一组的状态。单组及历史单组任务省略 comparison。查询、幂等重提和取消均返回相同结构；证据入口允许读取两组及各自清理中已记录的证据。status 为原任务生命周期；result 为原有 outcome、summary、criteria、evidence 结构，无报告时为 null。steps 包含 stepId、status、summary、evidenceRefs、criteria、startedAt、finishedAt；新任务另有 groupId 与 phase，标识 tab 分组及准备/检查/验证阶段。步骤状态为 PENDING、RUNNING、COMPLETED、BLOCKED、ERROR、SKIPPED。

`reportStatus` 是与 Console 验证报告一致的结论，新增字段不改变原有 `status`、`result.outcome` 或清理结果的语义。提交、查询、幂等重提与取消响应均返回：

| reportStatus   | 含义                                                 |
| -------------- | ---------------------------------------------------- |
| `null`         | 尚无最终报告；即使执行已结束也不自行推断结论         |
| `PASSED`       | 本次至少有一个验收项、全部通过，且验收执行完整       |
| `FAILED`       | 已确认至少一项失败；后续阻塞不抹掉已确认失败         |
| `INCONCLUSIVE` | 尚无确认失败，但存在无法判定、未验收、执行阻塞或错误 |

`criteriaCounts` 包含 `total`、`passed`、`failed`、`inconclusive`、`skipped`；按本次任务定义统计，缺失结果计入 `skipped`，四个分类之和等于 `total`。无报告时为 `null`。报告读取时计算这些字段，历史存档无需重写；证据清理不改变已有报告结论。重新验证需新建 caseId，不覆盖历史结果。

同任务末尾清理由 `cleanupStepIds` 标识，不纳入 `reportStatus` 和 `criteriaCounts` 的业务范围。业务验收全部通过且所有业务步骤（含前置操作）均完成时，即使后续清理失败或超时，业务结论仍为 `PASSED`；前置受阻、业务步骤缺失或未完成仍为 `INCONCLUSIVE`，明确的业务验收失败仍为 `FAILED`。原始 `status`、报告和 `result.outcome` 保留执行全过程事实，包括清理异常。Console 在“验证汇总”按业务步骤列出验收项，在“逐项验收”展示详情，“后续清理”单独展示清理记录与证据；读取历史报告也采用同一业务判定口径。

例如先确认一项失败，随后另一项因环境故障未执行，返回 `reportStatus: "FAILED"`、`criteriaCounts: { "total": 2, "passed": 0, "failed": 1, "inconclusive": 0, "skipped": 1 }`；原 `result.outcome` 仍可为 `BLOCKED`。这表示已知验收要求未满足，并不把环境故障认定为产品缺陷。

后续步骤故障或阻塞时，前面已完成的验收结论仍保留；未执行的全局验收项为 SKIPPED，整体 outcome 为 BLOCKED/ERROR，不能按局部 PASSED 当作全任务通过。没有最终报告时也能读取已持久化步骤；终态中未完成的步骤会明确标为错误或跳过，不继续显示正在执行。

## 业务清理与任务互斥

cleanup 中每项必填 url、exec_order、description，可选 stepId、policy、expected。没有 type；服务端将其转换成原任务末尾的 setup 步骤。业务与清理分别按 exec_order 排序，然后拼接，清理不会因为序号较小而提前执行。清理省略 stepId 时生成 cleanup-1、cleanup-2 等；包含自动生成身份在内，业务和清理之间也不能重名。每个任务最多 64 个步骤（业务和清理各最多 32 个）。清理不要求伪造业务验收项，执行完成仍须提供证据。

清理在同一次领取、同一浏览器会话中执行，不另建队列任务或重新登录。setup 未通过时跳过全部后续业务及清理；普通业务阻塞或局部执行错误会保留逐步结果，并在租约和预算有效时继续独立业务及清理。清理自身失败后停止后续清理，不自动重放。清理操作需要处理“对象未创建”或“操作部分完成”的情况。

取消、超时、租约失效或控制面因未知写入撤权后，任务不再执行清理，也不会自动另起任务补偿。尚未开始的清理显示 SKIPPED，已开始但未完成的清理显示 ERROR；可以通过具体步骤结果查看原因。清理只在业务执行权仍有效时开始；业务阶段已经超时、动作额度耗尽或被撤权时，不保证还能进入清理。进入清理后超出独立三分钟期限会记录 `CLEANUP_DEADLINE_EXCEEDED`，该错误不影响已经记录的业务验收结论。

历史独立清理任务及报告保留读取，当前版本不再调度；迁移 033 要求先在旧版本处理遗留清理并核实会话关闭，未完成时以 `LEGACY_CLEANUP_PENDING` 阻止升级。旧清理排队原因和所属 case 链接只用于解释历史记录。

steps 按实际执行顺序包含清理步骤；cleanup 仍提供 taskId、status、result 摘要，其中 taskId 就是该组原任务的身份，PENDING 表示尚未进入收尾阶段。清理摘要单独投影自己的步骤结论，result 在原任务报告交付前为 null。原任务报告覆盖业务和清理，清理的 expected 计入总验收项；清理受阻或错误会使整体 outcome 不完整，但不会抹掉已完成的业务验收结论。

新任务在自己的临时会话末尾清理，不再生成 resourceKey 或使用资源锁。DevPass 账号容量由外部租约约束；平台不隔离服务端业务数据，共用账号或业务对象的操作顺序仍需上游协调。历史双跑清理和结果只按原记录读取。

升级前已经提交的任务继续使用冻结的独立清理定义；同 caseId 幂等重提不会转换执行方式或创建新执行。新提交的 case 使用同任务收尾；重新执行沿用 caseId 并新增运行。

恢复值必须由上游明确提供。例如“恢复名称为 Fixture Member”可执行；仅写“恢复原值”且未提供原值，不会自动生成历史快照或变量绑定。

## 当前能力边界与上线

- 接口响应正文尚不属于 NETWORK 证据；现有网络元数据不能证明响应中的 memberId/memberName 与页面一致。
- 尚无业务下载文件采集及 CSV/XLSX 内容验收能力；点击 Export 不等于验证导出账单内容。
- schema、API 与 Agent 已支持结构化步骤；worker 领取时声明 structuredSteps 能力，旧 worker 不会领取新版任务。
- API 启动会应用 009-structured-cases.sql，新增逐步结果列及清理意图表；不删除旧任务与报告。
- Console 的 JSON 模式可直接提交 case 数组，详情展示步骤、约束、执行结果以及同任务清理状态（历史独立清理仍显示链接）。普通表单继续编辑原内部任务。
- 更新 contracts、API、Agent、Console 后部署；代码验证不替代真实业务环境验收。

同 profile 的 tab 共享登录与站点存储；身份材料只注入当前临时会话，人工处理不会保存快照或重启浏览器，运行结束不回写身份来源。网络/TRACE 当前为 profile 级证据，需要这类证据时分组串行。完整生命周期见 [架构说明](architecture.md#v2-profile-与-tab-分组)。

## 历史运行软删除

管理员通过 `POST /v1/tasks/{taskId}/delete` 删除一次完整运行，或通过 `POST /v1/tasks/delete` 提交 `{ "ids": ["taskId-1", "taskId-2"] }`，上限 100 个。双跑与历史独立清理共同删除；任一任务仍在运行、清理待执行或会话未核实关闭时整批返回 409。请求级入口为 `POST /v2/requests/{requestId}/delete` 与 `POST /v2/requests/delete`，仍被其他请求引用的执行保留。

软删除保留底层记录，隐藏列表与详情，并排除 Case、运行次数、通过率、趋势及关联 Tokens。涉及删除成员的旧分析整轮失效，其调用用量排除；剩余成员可重新生成分析。删除最新运行后默认读取前一条未删除运行；重复删除幂等，删除的运行幂等键不可复活。历史上不同 caseId 的旧重跑不会自动合并。

## 会话来源

`session.mode` 仅接受 `guest`、`manual`、`external`。省略时按访客准备要求生成 guest，否则使用人工临时会话，不调用账号选择 Agent。需要自动账号时显式选择 DevPass，提供 platform、poolId 或 accountId，以及 requirements；具体配置见 [DevPass 说明](../apps/api/src/modules/account-providers/README.md)。本地 identity/pool/auto 与 identityRef/poolRef 已移除，不能用于新提交或重跑。人工介入只影响当前临时会话，不保存为后续任务的登录来源。

### 重跑时重新配置会话

`POST /v2/cases/:id/rerun` 可传可选 `session`；`POST /v2/requests/:id/rerun` 在各 `caseIds[]` 映射中传可选 `session`，允许同一请求的不同 case 使用不同身份。字段沿用 `SessionRequest`，支持 `guest`、`manual`、`external`，例如：

```json
{
  "caseIds": [
    {
      "sourceCaseId": "public-page",
      "runId": "public-page-next",
      "session": { "mode": "guest" }
    },
    {
      "sourceCaseId": "account-page",
      "runId": "account-page-next",
      "session": { "mode": "manual" }
    }
  ]
}
```

省略 `session` 时沿用来源配置；历史本地身份仍返回 `LOCAL_IDENTITY_REMOVED`，须显式选择新的身份。覆盖只作用于新运行的冻结定义，保留步骤、验收、旧运行的报告与证据，不改变其他共享请求。显式替换会清除旧登录槽绑定；选择 `manual` 会允许当前新会话人工登录。业务准备要求仍参与冲突校验，不能用会话覆盖绕过访客或已登录要求。

相同 `runId` 的重试必须保持是否覆盖及会话内容一致；更换或撤销会话覆盖返回 409，须使用新的 `runId`。整请求重跑仍为原子提交。Console 的重跑弹窗支持逐 case 配置；提交结果不确定时冻结输入并沿用原运行 ID 重试，明确拒绝后可以修改配置。
