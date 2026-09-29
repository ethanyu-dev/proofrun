# 结构化 Case API v2

`POST /v2/cases` 接收数组，数组中每个对象是一个独立任务。任务之间受平台容量与业务上下文互斥约束；任务内部按 `exec_order` 升序执行，同序按原数组顺序串行。不会为每个步骤创建独立任务。

旧 `/v1/cases` 单 case 接口继续保留。新旧请求格式不混用；内部 `/v1/tasks` 不接收新版 case、结构化步骤或清理任务，也不支持对它们自动重跑或创建双组对照。重新执行应通过新版接口提交新的 caseId。

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

setup 的 expected 非空时必须全部 PASSED 才继续；空 expected 仍须提供执行证据。verification 的业务 FAILED/INCONCLUSIVE 不自动中断后续步骤；无法执行的 BLOCKED、执行 ERROR 或取消会停止后续步骤。步骤 COMPLETED 表示该步完成执行和结论交付，不等于其验收项全部通过。

## 等待与平台配置

明确时长请填写 wait.durationMs；仅在 description 写“等待一小时”不具备确定性计时语义。计时由 Agent 完成，不循环调用模型；期间续租、检查取消，等待完成后重新观察页面。纯等待步骤不主动导航至 url，保留现有会话上下文；若随后有 expected，则按该步入口继续观察与验收。

等待总时长必须小于平台任务预算，否则返回 422 WAIT_EXCEEDS_BUDGET。任务预算包含排队时间。领取时会再次受剩余时间限制；结构化任务只分配给会话上限能覆盖配置总预算的节点。

当前平台示例预算为 5 分钟，节点默认会话硬期限为 1 小时。因此 70 分钟等待需要部署方同时调整 case profile 的 budget.timeoutMs 和节点 max_session_ms，并为排队、操作和验收预留时间；任务预算上限仍为 24 小时。不自动改动部署配置。

本版不支持挂起释放会话，也不支持 worker 重启后从中间步骤继续。步骤结果已经持久化；失联仍按原租约规则结束任务，不能盲目重放可能产生副作用的动作。

## 查询与结果

- `GET /v2/cases/{caseId}`：读取主任务状态、逐步结果和清理状态。
- `POST /v2/cases/{caseId}/cancel`：取消主任务，已声明的业务清理仍独立进行。
- `GET /v2/cases/{caseId}/evidence/{artifactId}`：读取主任务步骤记录、主任务报告或关联清理报告引用的证据。

所有接口沿用部署管理员 Bearer 凭据。结果结构见 [CaseResultV2 Schema](../contracts/schemas/case-result-v2.schema.json) 与 [OpenAPI](../contracts/public-api.openapi.json)。

响应包含 caseId、status、result、steps、cleanup。status 为原任务生命周期；result 为原有 outcome、summary、criteria、evidence 结构，无报告时为 null。steps 包含 stepId、status、summary、evidenceRefs、criteria、startedAt、finishedAt。步骤状态为 PENDING、RUNNING、COMPLETED、BLOCKED、ERROR、SKIPPED。

后续步骤故障或阻塞时，前面已完成的验收结论仍保留；未执行的全局验收项为 SKIPPED，整体 outcome 为 BLOCKED/ERROR，不能按局部 PASSED 当作全任务通过。没有最终报告时也能读取已持久化步骤；终态中未完成的步骤会明确标为错误或跳过，不继续显示正在执行。

## 业务清理与任务互斥

cleanup 中每项必填 url、exec_order、description，可选 stepId、policy、expected。没有 type；服务端将其转换成独立清理任务中的 setup 步骤，按相同顺序规则执行。清理不要求伪造业务验收项，执行完成仍须提供证据。

清理意图和主任务在同一提交事务中保存；主任务终态且浏览器会话确认关闭后，调度器幂等生成清理任务，使用冻结的平台配置和独立的新预算。未领取就取消或超时的主任务，清理标为 SKIPPED。已开始执行的主任务即使失败或取消，也会执行声明的清理，因此清理操作应能够处理“对象未创建”或“操作部分完成”的情况。

cleanup 结果通过 taskId、status、result 关联，PENDING 表示正在等待安全调度条件。主任务结果不会被清理失败覆盖。主任务关闭状态未经核实，清理不会抢跑；清理失败也不会自动重放可能已经生效的写入。

当前以平台 nodePool、登录槽（没有显式登录槽时使用 environment.id）、显式登录节点及 entry 的 origin 生成保守互斥键。相同键的新版任务不会同时执行，主任务和清理共享互斥范围。不同键的任务可按已有 Agent 并发和节点容量并行。该键不是服务端数据的隔离机制；跨站共用资源或旧任务仍需上游协调。

清理尚未完成或未通过时，同上下文后续任务不会自动运行，排队预算仍正常消耗。清理失败需人工核实和恢复环境；本版不提供自动重试清理或自动解除该保护的接口。

恢复值必须由上游明确提供。例如“恢复名称为 Fixture Member”可执行；仅写“恢复原值”且未提供原值，不会自动生成历史快照或变量绑定。

## 当前能力边界与上线

- 接口响应正文尚不属于 NETWORK 证据；现有网络元数据不能证明响应中的 memberId/memberName 与页面一致。
- 尚无业务下载文件采集及 CSV/XLSX 内容验收能力；点击 Export 不等于验证导出账单内容。
- schema、API 与 Agent 已支持结构化步骤；worker 领取时声明 structuredSteps 能力，旧 worker 不会领取新版任务。
- API 启动会应用 009-structured-cases.sql，新增逐步结果列及清理意图表；不删除旧任务与报告。
- Console 的 JSON 模式可直接提交 case 数组，详情展示步骤、约束、执行结果以及清理任务链接。普通表单继续编辑原内部任务。
- 更新 contracts、API、Agent、Console 后部署；本次代码验证不自动部署、不运行真实 Novita 账号操作。
