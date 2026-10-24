# 测试身份

## 页面与默认任务流程

「测试身份」页面只维护六个字段：测试地址、Cookies、身份名称、身份类型（可选）、身份描述、并发数。系统内部生成唯一引用、版本和账号租约；用户不再配置 `loginRef`、账号池或站点规则。旧的配置来源切换入口不再展示。

Cookies 接受 `name=value; name=value` 或 JSON 数组。当前限定测试地址主机的根路径 Cookie，最多 32 条；留空保留原值，`[]` 清空种子。页面只显示是否配置。地址或 Cookie 改变生成新的材料版本，已冻结任务仍读取自己的版本。

省略 `session` 的 v2 case 先由独立身份选择 Agent 从同源候选选择账号。控制面取得账号租约后调度支持 `ephemeralProfiles` 的节点；节点创建空 profile，经私密通道注入 Cookie。账号并发上限以未确认关闭的会话计数，注入成功仍须通过页面身份和 setup 条件检查。

缺少身份材料或权限时允许按任务授权请求 HITL。人工操作只作用于当前会话；完成后确认相关条件、更新认证代次并交还 Agent，不导出 profile，不重启浏览器，不发布身份基准，也不自动把当前页面注册为新身份。下次任务仍从原材料重新准备。

人工“无法处理”需要具体原因，会结束当前 Case 的未完成执行并保留已有证据；不把人工决定当作业务验收失败。历史 baseline 列和旧文件保留用于兼容/维护，运行时不读取其内容。只存有旧人工基准且没有 Cookie 的账号需要补充身份来源。

## 存储与接口

元数据和修订号在 PostgreSQL。Cookie 存在 API 私有目录 `PROOFRUN_IDENTITY_SECRET_DIRECTORY/library`，未配置时使用 `PROOFRUN_ARTIFACT_DIRECTORY/.identity-secrets/library`；目录 `0700`，文件 `0600`。任务定义、模型上下文、持久命令和报告不包含 Cookie。投递会话创建命令时读取冻结版本，通过节点认证通道下发，并写入节点会话私有文件。

编辑和删除不删除历史种子，已冻结任务继续使用原版本。数据库与私有目录须一起备份，API 主备应挂载同一持久卷。Browser Node 不再保存完整 profile 或发布版本指针；升级前的历史基准文件暂不自动回收。

- 管理员：`GET /v1/admin/identity-library`、`POST /v1/admin/identity-library`、`POST /v1/admin/identity-library/remove`。
- Worker：`POST /v1/worker/identity-selection/claim`、`POST /v1/worker/identity-selection/finish`；领取实际任务声明 `identityVersion: 2`。
- HITL：`complete` 确认条件并交还；`unable` 提交必填 `reason`。

三端需一起更新：旧 Worker 不领取新身份库任务，未上报 `ephemeralProfiles` 的旧节点不能运行它们。原有身份目录不会自动迁移成六字段账号；请在新页面维护账号。显式 `session.mode=guest/manual/identity/pool/auto` 和已冻结历史任务保留旧协议，以下配置仅用于兼容入口。

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

这是 Case 的片段，仍需提供标准 `caseId`、`entry`、`steps` 和 `cleanup`。`poolId` 和 `accountId` 至少一个；`platform` 是 DevPass 中的稳定标识，origin 从 Case `entry` 推导。必须给出至少一个可核验身份条件，不允许与本地 `identityRef`、`poolRef` 或平台 `environment.auth` 混用。未配置来源会在提交时拒绝，原模式保持现有行为。

调度器先预留可用节点，再异步申请账号；等待额度期间不启动浏览器。PostgreSQL 持久保存随机申请键、原参数、租约和交还意图，网络响应丢失及 API 重启始终重放原键。解密后的 Cookie 只驻留 API 内存并通过节点认证通道投递，数据库、模型上下文和公开回执不含 Cookie/JWE。节点私密种子注入后立即删除；确认关闭后清理私有 profile，重启恢复也清理残留。

申请期限包含业务、收尾等待、清理、两分钟准备、五分钟人工余量和三十秒关闭余量；超过两小时或调用方上限时拒绝，需拆分 Case。DevPass 无续租能力，人工暂停和节点心跳都不能延长账号硬期限。延长重跑预算超过冻结账号期限时需提交新的完整 Case。未绑定会话的分配预留超时会终止并交还，绑定后的任务不会自动换账号重试。

新任务只申请单组账号租约。业务终态触发关闭；只有匹配的物理关闭证明才允许以 `usage_stopped=true` 交还。未确认停止时保留占用并重试，API 停机不宣称已经释放。

任务详情及 Console 展示申请键、账号、租约、材料版本、到期时间和释放状态。业务错误默认以 `execution_error` 交还，不据此停用账号。管理员核实账号异常后，可调用 `POST /v1/tasks/{taskId}/account-feedback`，正文为 `{"outcome":"credential_invalid","reason":"已人工核实的原因，不含秘密"}`；另支持 `identity_mismatch`、`account_state_changed`。该操作结束当前任务并在资源关闭后反馈，首次交还结论冻结后不允许改写。HITL “无法处理”本身不会反馈账号损坏。

## 旧协议兼容

`PROOFRUN_IDENTITY_CATALOG_FILE` 指定平台元数据 JSON：

```json
{
  "identities": [
    {
      "id": "team-member",
      "label": "团队成员测试账号",
      "accountKey": "test-user-1",
      "origins": ["https://example.test"],
      "maxConcurrent": 1,
      "checks": [
        {
          "id": "team",
          "description": "处于测试团队",
          "method": "text",
          "value": "测试团队"
        },
        {
          "id": "role",
          "description": "账号为非所有者且未绑定 GitHub",
          "method": "manual"
        }
      ]
    }
  ],
  "pools": [{ "id": "members", "identityRefs": ["team-member"] }],
  "sites": [
    {
      "id": "example",
      "hostname": "example.test",
      "environment": "production",
      "nodePool": "internal",
      "poolRef": "members"
    }
  ]
}
```

元数据不接受密码或 Cookie。`nodeId`/`stateId` 仅为历史兼容字段；不恢复节点快照或创建身份槽，缺少当前材料时按授权等待人工处理。前置条件的 `text`/`absent` 使用实际观察，`manual` 使用当前控制代次的人工确认；展示名不能替代角色证明。case 的 `session.requirements` 和步骤 `preconditions` 可追加条件，不能覆盖平台同名条件。

账号占用按全局 `accountKey` 计算，身份别名及对照组不绕过限制。事务内分配，任务结束但浏览器未确认关闭时仍保留占用。只有明确支持多会话的账号才提高 `maxConcurrent`；这不是浏览器 profile 数量。

自动登录由节点配置 `identity_library_file`（或 `PROOFRUN_IDENTITY_LIBRARY_FILE`）提供，文件须为节点用户可读的普通文件，权限 `0600`。元数据身份增加 `loginRef`，只将该引用下发。下例为夹具，不放真实秘密进仓库：

```json
{
  "profiles": {
    "member-login": {
      "origin": "https://example.test",
      "login": {
        "type": "cookies",
        "cookies": [
          { "name": "session", "value": "REPLACE_LOCALLY", "httpOnly": true }
        ]
      }
    }
  }
}
```

密码配方使用同源 `url`、`usernameSelector`、`passwordSelector`、`submitSelector`、`successSelector`、`username`、`password`，`type` 为 `password`。密码字段必须是原生 password input；提交前核对表单源，成功标记必须可见。跨域 SSO、iframe 或验证码由人工处理，不猜测选择器、不重复提交。该配方的 Cookie 为 host-only 根路径；复杂 Cookie 属性使用支持它们的外部材料来源，不能使用旧节点快照。

准备阶段单独两分钟、每执行最多一次，不能占用业务动作、模型次数或清理三分钟。先核验当前会话；条件不满足时清除该源的本地存储后尝试配方。至少一个正向 `text` 条件及所有自动条件满足才认为自动核验成功；有 `manual` 条件仍须人工确认。失败转逐步门禁/HITL，后续独立步骤继续。业务执行前重新观察并核验，准备成功不等于验收通过。

自动核验或人工完成均只影响当前临时会话，不保存快照或回写身份来源。业务 cleanup 可执行退出，本地存储清理不代表服务端登出；物理 profile 关闭后才释放账号。

外部库分成两个独立接口，可以由同一个身份管理系统提供：

| 位置       | 配置与调用                                                                                | 返回内容                                                  |
| ---------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| API 元数据 | `PROOFRUN_IDENTITY_CATALOG_URL`、`PROOFRUN_IDENTITY_CATALOG_TOKEN_FILE`；带 Bearer 的 GET | 与本地目录相同的 `identities`、`pools`、`sites`，禁止凭据 |
| Node 凭据  | 私有库配置 `provider.url`、`provider.tokenFile`；带 Bearer 的 POST                        | 与本地 profile 相同的 `origin`、`login` 配方              |

节点 POST 正文只有 `{"profileRef":"member-login","origin":"https://example.test"}`。接口返回配方须限定同一 origin。私有库可配置 `{"profiles":{},"provider":{"url":"https://identities.example.test/login-profile","tokenFile":"/private/provider-token"}}`；本地 profile 优先，缺失时查询提供方。令牌文件要求 `0600`；每次请求读取以支持轮换。提供方只能使用 HTTPS（本机回环测试例外），不跟随重定向，五秒超时，一 MiB 响应上限，拒绝未知字段。节点不缓存原始密码。

元数据缓存三十秒，到期获取失败时拒绝新的命名身份分配，不使用过期库；访客、普通人工会话及已冻结任务的幂等重提不依赖提供方。已领取任务沿用冻结身份，新 case／重跑按当前库解析。

管理员接口（使用现有管理员 Bearer）：

- `GET /v1/admin/identities`：元数据与来源。
- `GET /v1/admin/identities/settings`：读取配置版本、来源、地址、令牌是否存在；即使外部服务不可用也可读取。
- `POST /v1/admin/identities/settings`：保存带 `revision` 的配置。`mode=local` 携带 `catalog`，`mode=http` 携带 `url` 和可选更新 `token`，`mode=environment` 恢复部署默认值。未知字段、失效引用及过期版本被拒绝；外部连接验证失败不覆盖当前配置。
- `POST /v1/admin/identities/test`：使用相同正文验证草稿；不保存、不创建任务、不执行网站登录。
- `POST /v1/admin/identities/refresh`：刷新外部元数据，失败明确返回 `IDENTITY_PROVIDER_UNAVAILABLE`。
- `GET /v1/admin/identities/metrics`：最近三十天各登录来源和准备结果、自动核验比例、人工原因分类、当前占用和等待数。比例分母为已有终态回执的准备命令；历史无结束时间的记录不伪造耗时。

任务详情与报告展示实际选中的身份、登录方式、准备耗时、人工处理次数和账号释放情况，JSON 导出同步保留。准备成功与业务验收分开。账号池会跳过忙碌账号及能力不符的节点，只有真正分配节点才冻结身份。同一对照轮次固定相同账号；默认独占时两组依次运行，避免账号互踢污染对比。

## 验证

`pnpm test:api` 使用独立 PostgreSQL 验证版本、选择租约、私密投递和 HITL 终态；`pnpm test:agent` 验证选择工具和执行门禁；`pnpm test:console` 验证六字段表单及原因呈现；`cargo test --locked -p proofrun-node` 验证私密材料与节点协议边界。配置固定版本的 `PROOFRUN_AGENT_BROWSER_BIN` 与 `PROOFRUN_CHROME_BIN` 后运行 `pnpm test:identity:ephemeral`，在真实 Chrome 回环站点验证 当前会话状态、保存退役、下次会话隔离与网络脱敏。测试不代表生产站点账号或 Linux 部署已经验收。

外部链路由 `apps/api/test/external-accounts.test.ts` 验证真实 PostgreSQL/MCP HTTP/JWE、响应丢失、API 重启、期限和交还；其中 DevPass 服务、节点和业务为夹具。`pnpm test:identity:external` 使用上述浏览器环境变量，在真实 Chrome 回环页面验证 CDP 注入、path/httpOnly、种子删除和会话隔离，不代表生产 DevPass 或 Linux/systemd 已完成联调。
