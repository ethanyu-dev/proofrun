# 结构化 Case API v2

`POST /v2/cases` 接收数组，数组中每个对象是一个独立 case，默认创建纯 LLM 与 JEV+LLM 两组任务。不同 caseId 及同一 case 的两组可按平台容量并行执行；任务内部按 `exec_order` 升序执行，同序按原数组顺序串行。不会为每个步骤创建独立任务。

旧 `/v1/cases` 单 case 接口继续保留。新旧请求格式不混用；内部 `/v1/tasks` 不接收新版 case、结构化步骤或清理任务，也不支持从内部入口对它们自动重跑或追加双组对照。重新执行可使用下述 case 重跑接口，或通过新版提交接口提交新的 caseId。

查询结果包含可选的 `queueReason: { code, message } | null`，供排查任务为何尚未开始。它记录最近一次领取检查遇到的配置冲突、资源占用或节点不可用等原因；成功领取后清空，取消或排队超时后保留。null 或字段缺失表示尚无诊断，不保证节点可用。排队超时不代表业务验收失败，业务结果仍以实际执行报告为准。

## 提交与身份

请求样例见 [cases-v2.json](../contracts/examples/public-api/cases-v2.json)。示例地址、账号和恢复值为夹具，需要上游替换，不代表真实业务验收。

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $PROOFRUN_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @cases-v2.json \
  "$PROOFRUN_CONTROL_URL/v2/cases"
```

返回 202 和与输入顺序一致的结果数组。批次限制为 1–32 个 case，请求体仍受 2 MiB 限制。整批校验和事务接收，格式错误或任一身份冲突时不留下部分新任务。不同请求允许重叠 caseId；相同原始定义幂等返回已有结果，不重复执行。steps 的原始排列以及 policy/expected 的顺序属于该 case 定义的一部分；批次中的 case 排列不改变各自的幂等身份。

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

文字字段不接受纯空白，说明和数组中的字符串最多 2000 字符，policy/expected 各最多 32 项。每条 expected 的 criterionId 是 `<stepId>-expected-<原始位置+1>`，结果按此身份关联。自然语言 policy 会进入当前步骤的模型上下文；本版没有将其转换成程序强制校验规则。

setup 的 expected 为空时仍须提供执行证据。业务步骤的 FAILED/INCONCLUSIVE、BLOCKED 或局部执行 ERROR 都会记录后继续尝试后续步骤，不将未执行项误记为产品失败。每一步重新核实自身必要条件，前置条件缺失时只阻塞该步；不得假定失败的前置操作已经完成。取消、超时、租约失效或未知写入撤权会停止整个任务。步骤 COMPLETED 表示该步完成执行和结论交付，不等于其验收项全部通过。

## 等待与平台配置

明确时长请填写 wait.durationMs；仅在 description 写“等待一小时”不具备确定性计时语义。计时由 Agent 完成，不循环调用模型；期间续租、检查取消，等待完成后重新观察页面。纯等待步骤不主动导航至 url，保留现有会话上下文；若随后有 expected，则按该步入口继续观察与验收。

等待总时长必须小于平台任务预算，否则返回 422 WAIT_EXCEEDS_BUDGET。任务预算包含排队时间。领取时会再次受剩余时间限制；结构化任务只分配给会话上限能覆盖配置总预算的节点。

默认业务预算为 `300000 × steps.length` 毫秒，exec_order 的大小或重复不影响数量；每个业务步骤贡献 300 秒，业务步骤共享这段时长，不强制单步在 300 秒内结束。平台 profile 显式设置 budget.timeoutMs 时覆盖业务预算，仍受 24 小时上限约束。首次进入 cleanup 时，控制面另行签发固定 180000 毫秒（三分钟）期限，整段清理共享，既不受业务剩余时间限制，也不会累加业务剩余时间。清理步骤切换、重复上报、控制面重启和人工交接均不重置该期限；清理期间人工等待也计时。两组各自独立计时；动作和模型调用上限仍按整组累计。节点会话容量须覆盖业务预算加三分钟清理预留。

节点默认会话硬期限为 1 小时；较多步骤或长时间等待可能需要提高节点 max_session_ms。70 分钟显式等待还需确保 profile 总预算大于等待时长，为排队、操作和验收预留时间。请求格式保持不变，不接受调用方传入预算或模式。

本版不支持挂起释放会话，也不支持 worker 重启后从中间步骤继续。步骤结果已经持久化；失联仍按原租约规则结束任务，不能盲目重放可能产生副作用的动作。

## 查询与结果

`POST /v2/cases/{caseId}/rerun` 接收 `{"caseId":"新的-caseId"}`，返回 202 和新 case 的单个 `CaseResultV2`。沿用原 case 的业务定义、环境、总预算、取证类型和执行模式，按当前编译规则生成新步骤及末尾清理；不会复制旧执行状态或报告。原 case 为双跑时整体重建两组，单组时保留原策略。已有 case 即使在平台配置变化或撤下后仍可重跑；如需使用当前平台配置，应改用 `POST /v2/cases` 提交新身份。

新身份必须不同于原 caseId，格式与提交一致。相同新 caseId 和相同业务定义的重试返回已存在结果，不再执行；不同定义占用该身份时返回 409 CASE_CONFLICT。请求不接受预算或步骤覆盖。Console 的列表和详情页统一显示“重跑整个 case”，从任一对照组点击均重跑整个 case，并跳转到新主任务。

- `GET /v2/cases/{caseId}`：读取主任务状态、逐步结果和清理状态。
- `POST /v2/cases/{caseId}/cancel`：取消该 case 的所有执行组，同时停止尚未执行的清理。历史独立清理任务保留旧语义。
- `GET /v2/cases/{caseId}/evidence/{artifactId}`：读取主任务步骤记录、主任务报告或关联清理报告引用的证据。

所有接口沿用部署管理员 Bearer 凭据。结果结构见 [CaseResultV2 Schema](../contracts/schemas/case-result-v2.schema.json) 与 [OpenAPI](../contracts/public-api.openapi.json)。

响应包含 caseId、status、reportStatus、criteriaCounts、result、steps、cleanup。双跑时额外返回 `comparison: { id, arms }`；arms 按 llm、jev 顺序分别包含 taskId、executionMode 和各自的完整 case 结果（含步骤、清理及排队原因）。顶层字段保持纯 LLM 主组的原有投影，不能用顶层完成或通过推断另一组的状态。单组及历史单组任务省略 comparison。查询、幂等重提和取消均返回相同结构；证据入口允许读取两组及各自清理中已记录的证据。status 为原任务生命周期；result 为原有 outcome、summary、criteria、evidence 结构，无报告时为 null。steps 包含 stepId、status、summary、evidenceRefs、criteria、startedAt、finishedAt。步骤状态为 PENDING、RUNNING、COMPLETED、BLOCKED、ERROR、SKIPPED。

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

清理在同一次领取、同一浏览器会话中执行，不另建队列任务或重新登录。业务步骤逐项尝试后进入清理；前置验收失败、业务阻塞或局部执行错误会保留逐步结果，并在租约和预算有效时继续后续业务及清理。清理自身失败后停止后续清理，不自动重放。清理操作需要处理“对象未创建”或“操作部分完成”的情况。

取消、超时、租约失效或控制面因未知写入撤权后，任务不再执行清理，也不会自动另起任务补偿。尚未开始的清理显示 SKIPPED，已开始但未完成的清理显示 ERROR；可以通过具体步骤结果查看原因。清理只在业务执行权仍有效时开始；业务阶段已经超时、动作额度耗尽或被撤权时，不保证还能进入清理。进入清理后超出独立三分钟期限会记录 `CLEANUP_DEADLINE_EXCEEDED`，该错误不影响已经记录的业务验收结论。

历史独立清理任务仍在主任务终态且会话关闭经核实后调度；主任务结果不会被清理失败覆盖。领取时固定到主任务实际执行节点，原节点离线或容量不足时等待；路由或显式登录节点冲突返回 `CLEANUP_NODE_CONFLICT`，关联缺失返回 `CLEANUP_PARENT_MISSING`，主任务未结束或会话未关闭返回 `CLEANUP_PARENT_PENDING`。控制台列表保留历史清理所属 case 的链接。

steps 按实际执行顺序包含清理步骤；cleanup 仍提供 taskId、status、result 摘要，其中 taskId 就是该组原任务的身份，PENDING 表示尚未进入收尾阶段。清理摘要单独投影自己的步骤结论，result 在原任务报告交付前为 null。原任务报告覆盖业务和清理，清理的 expected 计入总验收项；清理受阻或错误会使整体 outcome 不完整，但不会抹掉已完成的业务验收结论。

双跑两组分别在自己的会话末尾清理。当前以 caseId 对应的主任务身份、平台 nodePool、登录槽（没有显式登录槽时使用 environment.id）、显式登录节点及 entry 的 origin 生成互斥键，双跑时进一步按组隔离。不同 caseId 即使环境、账号与站点相同，也不互相等待。两组从同一轮不可变登录快照启动，各自使用独立浏览器 profile；该键不隔离服务端业务数据，共用账号或业务对象的操作顺序仍需上游协调。

升级前已经提交的任务继续使用冻结的独立清理定义；同 caseId 幂等重提不会转换执行方式或创建新执行。新提交的 case 使用同任务收尾；重新执行需要新 caseId。

恢复值必须由上游明确提供。例如“恢复名称为 Fixture Member”可执行；仅写“恢复原值”且未提供原值，不会自动生成历史快照或变量绑定。

## 当前能力边界与上线

- 接口响应正文尚不属于 NETWORK 证据；现有网络元数据不能证明响应中的 memberId/memberName 与页面一致。
- 尚无业务下载文件采集及 CSV/XLSX 内容验收能力；点击 Export 不等于验证导出账单内容。
- schema、API 与 Agent 已支持结构化步骤；worker 领取时声明 structuredSteps 能力，旧 worker 不会领取新版任务。
- API 启动会应用 009-structured-cases.sql，新增逐步结果列及清理意图表；不删除旧任务与报告。
- Console 的 JSON 模式可直接提交 case 数组，详情展示步骤、约束、执行结果以及同任务清理状态（历史独立清理仍显示链接）。普通表单继续编辑原内部任务。
- 更新 contracts、API、Agent、Console 后部署；代码验证不替代真实业务环境验收。
