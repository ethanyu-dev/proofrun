# ProofRun Case API

## 访问地址与在线文档

- 生产 HTTP API：`https://api-proofrun.ethankit.com`。
- [在线 API 文档](https://api-proofrun.ethankit.com/docs/)：覆盖 v1/v2 的提交、查询、取消和证据下载，可查看请求结构和响应并手动调试。
- [在线 OpenAPI JSON](https://api-proofrun.ethankit.com/openapi.json)：可导入 API 客户端；在线规范使用当前访问来源，导入工具时将服务地址设置为上述 API origin。
- Console：`https://proofrun.ethankit.com`；同源文档也可通过 `/docs/` 访问。

文档无需令牌即可阅读；调用业务接口仍需 `Authorization: Bearer <token>`。在线调试不会自动填入或持久化令牌，提交与取消会执行真实操作。外部系统应从自己的服务端调用 API；Console 与 Browser Node 继续使用 Console 的同源入口，不需要为它们开启跨域访问。

以下命令使用环境变量保存接入地址，令牌由部署管理员通过私密渠道提供：

```sh
export PROOFRUN_CONTROL_URL='https://api-proofrun.ethankit.com'
```

## 协议选择

结构化步骤和批量提交使用 [Case API v2](public-api-v2.md)。本页描述继续兼容的 `/v1/cases` 单 case 接口。

对外只约定“验证哪个 case、怎样算通过、最后得到什么结果”。待测入口 URL 属于 case 本身，由调用方明确提供；环境、登录态、节点、预算、模型和执行策略由平台管理。

## 提交 case

`POST /v1/cases`，使用部署方提供的控制面地址和 Bearer 凭据：

```json
{
  "caseId": "notification-default-001",
  "description": "验证邮件通知默认开启。只检查，不修改或保存。",
  "url": "https://app.example.com/settings",
  "steps": ["进入通知设置区域", "观察邮件通知开关"],
  "acceptanceCriteria": [
    {
      "id": "email-enabled",
      "description": "读取通知设置区域的邮件通知开关状态。",
      "expectedResult": "邮件通知默认开启。"
    }
  ]
}
```

| 字段               | 含义                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| caseId             | 本次验证的唯一身份；必填，1–100 位字母、数字、下划线或短横线                                            |
| description        | 必填，完整任务描述：验证目标、业务背景、涉及对象及必要约束                                              |
| url                | 必填，本次待测的 HTTP(S) 入口地址；必须能从执行节点访问                                                 |
| steps              | 可选的必要业务步骤，最多 32 条，每条最多 2000 字符；不要求提供固定点击路径                              |
| acceptanceCriteria | 必填，至少一项；每项 id 在 case 内唯一，description 描述检查对象及观察时机，expectedResult 描述业务预期 |

description 和验收文本不得为空或仅含空白。url 不接受空值、相对路径或非 HTTP(S) 地址，平台不再提供默认待测地址。每项必须验证的结果都应出现在 acceptanceCriteria 中。平台不会自行增加或降低验收标准；文字中的“不保存”等要求由执行 Agent 理解执行，不是独立的业务写入权限规则。请求不接受未定义字段。

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $PROOFRUN_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @case.json \
  "$PROOFRUN_CONTROL_URL/v1/cases"
```

返回 `202`，表示已经接收：

```json
{
  "caseId": "notification-default-001",
  "status": "QUEUED",
  "reportStatus": null,
  "criteriaCounts": null,
  "result": null
}
```

同 caseId、同定义重提不会重复执行，返回当前状态；定义不同返回 `409 CASE_CONFLICT`。响应丢失时查询或重提原 caseId；不要自动换身份再次运行。明确要重新执行时使用新的 caseId。

## 查询结果

`GET /v1/cases/{caseId}`，使用相同 Bearer 凭据。建议每 1–5 秒查询一次，目前没有结果 webhook。

- status：QUEUED、RUNNING、COMPLETED、CANCELLED、TIMED_OUT、ERROR。
- reportStatus：验证报告统一状态，PASSED（通过）、FAILED（未通过）、INCONCLUSIVE（无法判定）；无报告时为 null。与 Console 报告页使用同一计算规则。
- criteriaCounts：验收项统计，包含 total、passed、failed、inconclusive、skipped；无报告时为 null，缺失项计入 skipped，各分类之和等于 total。
- result：尚无报告时为 null，包括部分异常终态。已有报告时包含 outcome、summary、criteria 和 evidence。
- outcome：保留兼容的旧字段，PASSED（全部通过）、FAILED（至少一项失败）、INCONCLUSIVE（无法充分判断）、BLOCKED（无法开展验收）、ERROR（执行故障）。

**COMPLETED 只表示执行结束；新调用方以 reportStatus=PASSED 判断本次验收通过。** criteria 通过 criterionId 对应提交时的验收项，每项给出 verdict、summary 和 evidenceRefs。逐项 verdict 为 PASSED、FAILED、INCONCLUSIVE 或 SKIPPED。BLOCKED/ERROR 的验收项为 SKIPPED；平台执行故障不代表业务功能失败。

每份 evidence 包含 id、kind、url、sha256；kind 是证据媒介，调用方无须预先选择。使用同一控制面的 `GET /v1/cases/{caseId}/evidence/{artifactId}` 下载报告引用的证据并核对原始字节摘要。只能读取该 case 报告中的证据；保留期清理后可能不可下载。截图为 PNG，其他证据为 JSON；不要向任意外部地址转发凭据。

结果摘要和证据可能含业务页面内容；隐藏平台配置不等于对页面证据做脱敏。模型结论附带可追溯证据，不等于独立人工复核。

## 取消与错误

`POST /v1/cases/{caseId}/cancel`，无请求体，返回当前 case 状态。取消不会撤销已经发生的业务操作；浏览器资源回收由平台处理。

应用错误结构为 `{"code":"INVALID_CASE","message":"..."}`，调用方按 HTTP 状态及 code 处理：

| 状态 / code                             | 处理                                    |
| --------------------------------------- | --------------------------------------- |
| 400 INVALID_CASE                        | 输入格式不正确或包含平台字段，修正 case |
| 422 INVALID_CASE                        | 验收项 id 重复，修正 case               |
| 401 UNAUTHORIZED                        | 核实调用凭据                            |
| 404 CASE_MISSING                        | case 不存在                             |
| 404 EVIDENCE_MISSING / ARTIFACT_MISSING | 证据不属于该 case、未交付或已清理       |
| 409 CASE_CONFLICT                       | caseId 已绑定另一份定义                 |
| 503 CASE_NOT_CONFIGURED                 | 平台尚未完成执行配置，联系平台维护者    |
| 503 其他错误                            | 控制面暂不可用，有界退避并保留原 caseId |

JSON 请求体上限为 2 MiB，超限返回 413。调用方等待超时不会自动取消服务端验证。当前凭据复用部署方管理员 token，未提供独立调用方权限或多租户隔离；凭据应由服务端保管。

## 文档与版本

- [OpenAPI](../contracts/public-api.openapi.json)：包含 v1/v2 各自的提交、查询、取消、证据下载操作，可单文件导入；仓库版本默认指向生产 API，自部署时替换服务地址。
- [VerificationCase Schema](../contracts/schemas/verification-case.schema.json) 与 [CaseResult Schema](../contracts/schemas/case-result.schema.json)：协议源文件。
- [请求示例](../contracts/examples/public-api/case.json)、[入队响应](../contracts/examples/public-api/case-queued.json)、[阻塞结果](../contracts/examples/public-api/case-blocked.json)：均为演示数据，不是真实验收记录。

本版取代此前把内部 VerificationTask 直接作为公共输入的方案，并将 case 的 objective 改为 description、增加必填 url；旧 case 请求应同步修改，不接受 objective 别名。使用 `/v1` 路径，不要求调用方额外填写 protocolVersion。删除、改名或改变字段含义、增加必填输入等破坏性变化需升级接口版本；新增可选字段也应同步 Schema、文档与调用方校验器。

平台如何绑定执行环境见[平台配置说明](case-platform-config.md)，不属于调用方接入步骤。现有 `/v1/tasks`、节点、worker、人工控制和模型对比接口保留给内部组件，不列入公共 Case API。
