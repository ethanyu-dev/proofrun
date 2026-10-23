# ProofRun Case API

查询结果包含可选的 `queueReason: { code, message } | null`，供排查任务为何尚未开始。它记录最近一次领取检查遇到的配置冲突、资源占用或节点不可用等原因；成功领取后清空，取消或排队超时后保留。null 或字段缺失表示尚无诊断，不保证节点可用。排队超时不代表业务验收失败，业务结果仍以实际执行报告为准。

## 访问地址与在线文档

- 生产 HTTP API：`https://api-proofrun.ethankit.com`。
- [在线 API 文档](https://api-proofrun.ethankit.com/docs/)：覆盖 v2 的提交、查询、取消和证据下载，可查看请求结构和响应并手动调试。
- [在线 OpenAPI JSON](https://api-proofrun.ethankit.com/openapi.json)：可导入 API 客户端；在线规范使用当前访问来源，导入工具时将服务地址设置为上述 API origin。
- Console：`https://proofrun.ethankit.com`；同源文档也可通过 `/docs/` 访问。

文档无需令牌即可阅读；调用业务接口仍需 `Authorization: Bearer <token>`。在线调试不会自动填入或持久化令牌，提交与取消会执行真实操作。外部系统应从自己的服务端调用 API；Console 与 Browser Node 继续使用 Console 的同源入口，不需要为它们开启跨域访问。

以下命令使用环境变量保存接入地址，令牌由部署管理员通过私密渠道提供：

```sh
export PROOFRUN_CONTROL_URL='https://api-proofrun.ethankit.com'
```

## 接入协议

使用 [Case API v2](public-api-v2.md) 提交结构化步骤或请求封装，读取结果、取消任务和下载证据。示例见 [批量 case](../contracts/examples/public-api/cases-v2.json) 与 [请求封装](../contracts/examples/public-api/request-v2.json)，协议见 [OpenAPI](../contracts/public-api.openapi.json)。示例均为演示数据，不是真实验收记录。

`/v1/cases` 的提交、查询、取消与证据下载接口已移除，调用返回 404。原调用方需将业务定义转换为 v2 的 `entry`、`steps` 和 `cleanup` 结构；不是只替换 URL 前缀。新 case 使用新的业务身份，平台不会自动迁移或重新执行旧任务。

历史 v1 case 的任务快照、报告和证据继续保留，可由管理员通过 Console 的执行记录或内部 `/v1/tasks`、证据接口查阅。内部任务、节点、worker 与人工控制接口不属于此次移除范围，也不列入公共 Case API。

环境、登录态、节点、预算和模型由部署方配置，见[平台配置说明](case-platform-config.md)。凭据仍是部署管理员 token，需由可信服务端保管。
