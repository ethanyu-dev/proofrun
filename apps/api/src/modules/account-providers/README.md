# 会话与外部账号

省略 session 或使用 `session.mode=auto` 时，按每个 case 的原始操作和前置条件判断身份需求。明确要求访客的使用空白会话；没有登录要求时不取账号。明确需要登录时，用 case 的 `platform` 与 `entry` 的精确 origin 向 DevPass 查询可用账号，不要求控制台用户填写账号池或核验文本。`platform` 应与 DevPass 登记的平台标识一致；也可通过 auto 的 `external` 提供既有稳定平台、账号池或指定账号范围。账号可用范围仍由 DevPass 调用方授权控制，不能通过 case 文字扩大权限。

DevPass 明确返回无匹配账号或无额度时，本次运行改为临时人工会话，并要求 HITL 确认登录与原有身份条件。未配置 DevPass 或所需租期超过配置上限也走人工准备。原始步骤、policy 和身份核验条件保持不变；Cookie 注入成功不代表业务身份核验通过。网络超时或丢响应不代表无账号，仍重放原申请键；已有租约继续受关闭和交还约束。平台显式禁止人工介入时不会绕过该限制。

`guest`、`manual`、`external` 仍可作为 API 的显式约束；显式 external 要提供可核验条件。重跑按钮直接创建新运行，默认重新判断身份需求并沿用原步骤、核验条件和已有外部账号范围，不再弹出身份选择表单。

本地账号管理 API、身份选择 API、Cookie 库和节点登录配方均已移除。旧本地身份快照只供读取；历史 case 重跑自动移除旧本地身份及登录槽引用，为新运行重新准备会话。历史数据库迁移、记录和私有文件不自动删除；它们不再用于账号分配。API、Agent 与 Browser Node 必须一起更新。

## DevPass 外部账号

显式 `session.mode=external` 使用 DevPass MCP 租约。当前接收 `browser_cookies`，不接收 `browser_storage` 或 `http_bearer`。每个会话使用全新 profile，经私有 CDP 注入完整 Cookie 属性；不复制节点模板、不恢复本地登录槽、不保存人工基准。页面身份与业务前置条件仍由执行 Agent 和 HITL 核验，注入成功不等于登录或验收通过。

API 配置 `PROOFRUN_DEVPASS_CONFIG_FILE`，指向下列 JSON 文件。配置本身、令牌文件、PKCS8 私钥文件均须为 `0600` 的普通文件，内容不进入仓库。先在 DevPass 登记调用方、接收公钥、平台及账号池授权；`clientId` 与接收 key ID 必须一致。当前一个 API 部署配置一个来源。

```json
{
  "id": "devpass",
  "url": "https://devpass.example.test/mcp",
  "clientId": "proofrun",
  "tokenFile": "/private/devpass/token",
  "privateKeyFiles": { "proofrun-key-1": "/private/devpass/receiver.pem" },
  "maxDurationSeconds": 7200
}
```

仅本机开发可增加 `allowLoopback: true` 使用回环 HTTP；不跟随重定向。令牌和私钥每次申请读取；轮换时保留旧 key ID 到全部旧租约结束。API、Agent、Browser Node 一起更新，节点必须声明 `externalAccounts` 能力。工作区内固定版本 SDK 由 `pnpm build:devpass` 构建，常用根脚本与部署镜像已包含该步骤。

在 `POST /v2/cases` 的 Case 中加入：

```json
{
  "session": {
    "mode": "external",
    "external": {
      "provider": "devpass",
      "platform": "example-production",
      "poolId": "members",
      "roles": ["member"]
    },
    "requirements": [
      {
        "id": "member",
        "description": "当前账号为测试成员",
        "method": "text",
        "value": "测试成员"
      }
    ]
  }
}
```

这是显式 external 的 Case 片段，仍需提供标准 `caseId`、`entry`、`steps` 和 `cleanup`。`poolId` 和 `accountId` 均可省略，由 DevPass 在调用方获授权的范围内选择；`platform` 是 DevPass 中的稳定标识，origin 从 Case `entry` 推导。显式 external 必须给出至少一个可核验身份条件，不允许与本地 `identityRef`、`poolRef` 或平台 `environment.auth` 混用。显式来源未配置时拒绝提交，自动流程则转 HITL。

调度器先预留可用节点，再异步申请账号；显式 external 等待额度期间不启动浏览器，自动会话收到明确无额度结果则改为人工会话。PostgreSQL 持久保存随机申请键、原参数、租约和交还意图，网络响应丢失及 API 重启始终重放原键。解密后的 Cookie 只驻留 API 内存并通过节点认证通道投递，数据库、模型上下文和公开回执不含 Cookie/JWE。节点私密种子注入后立即删除；确认关闭后清理私有 profile，重启恢复也清理残留。

申请期限包含业务、收尾等待、清理、两分钟准备、五分钟人工余量和三十秒关闭余量；超过两小时或调用方上限时拒绝，需拆分 Case。DevPass 无续租能力，人工暂停和节点心跳都不能延长账号硬期限。延长重跑预算超过冻结账号期限时需提交新的完整 Case。未绑定会话的分配预留超时会终止并交还，绑定后的任务不会自动换账号重试。

新任务只申请单组账号租约。业务终态触发关闭；只有匹配的物理关闭证明才允许以 `usage_stopped=true` 交还。未确认停止时保留占用并重试，API 停机不宣称已经释放。

任务详情及 Console 展示申请键、账号、租约、材料版本、到期时间和释放状态。业务错误默认以 `execution_error` 交还，不据此停用账号。管理员核实账号异常后，可调用 `POST /v1/tasks/{taskId}/account-feedback`，正文为 `{"outcome":"credential_invalid","reason":"已人工核实的原因，不含秘密"}`；另支持 `identity_mismatch`、`account_state_changed`。该操作结束当前任务并在资源关闭后反馈，首次交还结论冻结后不允许改写。HITL “无法处理”本身不会反馈账号损坏。
