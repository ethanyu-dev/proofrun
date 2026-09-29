# @proofrun/contracts

JSON Schema 是协议数据结构的源文件；TypeScript 类型由脚本生成并提交。新版上层调用使用 VerificationCaseV2 数组与 CaseResultV2，见[结构化 Case API](../docs/public-api-v2.md)；VerificationCase 与 CaseResult 继续服务旧 [v1 接口](../docs/public-api.md)。VerificationTask 和 VerificationReport 属于平台内部协议。NodeCommand、NodeEvent、ControlRequest、ExecutionGrant、AgentDecision 等内部协议由项目组件配套使用，不整体承诺为第三方稳定 API。

节点和控制面请求的字段说明写在 Schema 的 `description` 中，生成器会把它们带入 TypeScript 类型注释；NodeCommand 的说明也会进入 Rust 构建期生成类型。不要直接改 `src/generated/` 或 Cargo 的 `OUT_DIR`。

旧版公开 case 包含 caseId、description、必填 url、可选 steps 和 acceptanceCriteria；调用方指定待测入口，但不能指定环境、登录态、预算、取证策略或执行模式。平台配置与原始 case 一起存入内部任务快照，公开结果仅返回状态、验收结论和证据。

`public-api.openapi.json` 是可独立导入的 OpenAPI 3.1 文档，由 `scripts/generate-public-api.mjs` 复用共享 Schema 生成。HTTP 方法、响应码和薄请求封装在该脚本维护，并与 `apps/api/src/app.ts` 和领域层同步。OpenAPI 包含 v1/v2 的 case 提交、查询、取消与证据下载；验收项 ID 唯一性和证据归属仍由领域层校验。现有生成和漂移检查命令同时覆盖 OpenAPI，不直接编辑生成文件。

`examples/public-api/case.json`、`case-queued.json`、`case-blocked.json` 是业务输入与结果示例，不是真实环境验收结果。版本兼容规则见对外调用文档。平台部署配置见 `docs/case-platform-config.md`。

`src/index.ts` 提供 Ajv 校验器；生成的 TS 类型不能替代运行时校验。此包只验证结构。API 领域层进一步验证验收覆盖、证据存在和归属、整体 verdict 与逐项结果一致，集成测试在 apps/api/test 中。校验无法证明模型的业务判断正确。

Rust 的 build.rs 使用 typify 从同一个 NodeCommand schema 生成命令类型。因为 serde 对部分无字段变体的额外属性处理较宽松，节点入口还会执行完整 JSON Schema 校验。NodeEvent 描述节点输出；Linux 联调捕获的真实输出可由 `tests/browser-node/validate-events.mjs` 使用 TS 侧 Ajv 验证。不要在 TS 与 Rust 中分别手写两套同名命令协议。

```sh
pnpm contracts:generate
pnpm contracts:check
pnpm test:contracts
```

schema 的 `proofrun.invalid` 标识是离线协议标识，不是线上文档服务，也不应发生远端 schema 拉取。

ExecutionGrant 明确执行令牌、节点会话与任务硬期限；AgentDecision 只包含模型可提出的浏览器意图和验收结论，身份由执行器补充。报告可携带执行原因、调用数、动作数、命令身份和服务返回的 token 计数；指标来自 worker，不代表独立计费审计。旧任务 BLOCKED/ERROR 的标准项只能为 SKIPPED；结构化任务通过 steps 保留前面已完成的验收，未执行项仍为 SKIPPED。

## Console 读取协议

`task-list.schema.json`、`task-detail.schema.json` 和 `node-list.schema.json` 约束管理员读取响应。前端使用同源生成类型，API 集成测试校验实际响应；浏览器端不导入依赖 Node.js 文件系统的运行时校验入口。任务与报告定义继续复用已有协议，执行凭据不进入读取视图。
