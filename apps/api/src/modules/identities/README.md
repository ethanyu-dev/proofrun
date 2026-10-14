# 测试身份

## 页面与默认任务流程

「测试身份」页面只维护六个字段：测试地址、Cookies、身份名称、身份类型（可选）、身份描述、并发数。系统内部生成唯一引用、版本和账号租约；用户不再配置 `loginRef`、账号池或站点规则。旧的配置来源切换入口不再展示。

Cookies 接受 `name=value; name=value` 或 JSON 数组 `[{"name":"session","value":"REPLACE_LOCALLY","httpOnly":true}]`。当前限定测试地址主机的根路径 Cookie，最多 32 条；不接受跨域或路径配置。留空保留已配置值，新账号留空则由人工准备；`[]` 清空种子。页面只回显是否配置，不回显秘密。修改地址或重新填写 Cookies 创建新版本，原人工基准不再用于新任务；仅修改名称、类型、描述或并发数不丢弃基准。

省略 `session` 的新 v2 case 会冻结同源身份候选，进入以下流程：

1. Worker 领取独立的身份选择工作。薄身份 agent 单次调用模型，只读取 Case 要求和身份摘要，返回一个候选或“无需身份 / 需要人工”。提示词位于 `apps/agent/src/prompts/identity-selector.ts`，不运行浏览器循环。
2. 同一对照轮次共享选择。控制面获得账号并发租约后，要求支持 `fullProfile` 的 Browser Node 创建独立会话。并发数是账号的全局会话上限，只有浏览器确认关闭才释放。
3. 节点复制完整、已关闭的 profile 基准。首次使用可复制节点的 `base_profile_directory` 环境模板；未配置则从空 profile 开始。首次准备清除目标站点的旧身份存储、注入 Cookie 并刷新。已有人工基准时直接恢复它，不再注入更旧的种子。
4. 加载成功只表示状态已注入，执行 Agent 仍根据页面核验登录和 Case 的条件。没有合适身份、缺失 Cookie 或页面身份无效时进入 HITL。没有候选时创建内部待准备身份，人工成功后才出现在身份库。
5. 普通任务完成、失败和清理都不更新基准。只有 HITL 逐项确认完成，才关闭浏览器、发布完整 profile 副本并重启任务继续执行。浏览器退出可能删除会话 Cookie，因此完整目录同时保存同版本的会话状态补充文件。旧并发任务不能覆盖较新的人工基准。

完整 profile 包含磁盘中的站点存储与配置（包括 IndexedDB 等），不包含进程内存、未提交表单或 JS 堆。HITL 完成会重启浏览器并重建任务标签页，旧观察句柄作废。基准固定在所属 Browser Node；当前不提供跨节点 profile 迁移。复制拒绝运行中的 profile、符号链接和特殊文件，单份上限 2 GiB / 100,000 文件。不要把正在使用的个人浏览器目录直接设为模板。

HITL 可选择“无法处理”，必须填写原因。该操作结束整个 Case 的未完成组，保留已有证据和已完成步骤；结果为“人为判定无法执行”，展示人工原因，验收 verdict 为空。它不保存基准；重新打开原处理链接仍能读取原因。

## 存储与接口

元数据和修订号在 PostgreSQL。Cookie 存在 API 私有目录 `PROOFRUN_IDENTITY_SECRET_DIRECTORY/library`，未配置时使用 `PROOFRUN_ARTIFACT_DIRECTORY/.identity-secrets/library`；目录 `0700`，文件 `0600`。任务定义、模型上下文、持久命令和报告不包含 Cookie。投递会话创建命令时读取冻结版本，通过节点认证通道下发，并写入节点会话私有文件。

编辑和删除不删除历史种子，已冻结任务继续使用原版本。数据库与私有目录须一起备份，API 主备应挂载同一持久卷。完整 profile 与版本指针保存在 Browser Node 的认证状态目录中；历史 profile 暂不自动回收。

- 管理员：`GET /v1/admin/identity-library`、`POST /v1/admin/identity-library`、`POST /v1/admin/identity-library/remove`。
- Worker：`POST /v1/worker/identity-selection/claim`、`POST /v1/worker/identity-selection/finish`；领取实际任务声明 `identityVersion: 2`。
- HITL：`complete` 发布基准并交还；`unable` 提交必填 `reason`。

三端需一起更新：旧 Worker 不领取新身份库任务，未上报 `fullProfile` 的旧节点不能运行它们。原有身份目录不会自动迁移成六字段账号；请在新页面维护账号。显式 `session.mode=guest/manual/identity/pool/auto` 和已冻结历史任务保留旧协议，以下配置仅用于兼容入口。

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

元数据不接受密码或 Cookie。`nodeId`/`stateId` 可成对引用已有节点快照；不配置时创建身份专属槽，缺少状态则等待人工登录。前置条件的 `text`/`absent` 使用实际观察，`manual` 使用当前控制代次的人工确认；展示名不能替代角色证明。case 的 `session.requirements` 和步骤 `preconditions` 可追加条件，不能覆盖平台同名条件。

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

密码配方使用同源 `url`、`usernameSelector`、`passwordSelector`、`submitSelector`、`successSelector`、`username`、`password`，`type` 为 `password`。密码字段必须是原生 password input；提交前核对表单源，成功标记必须可见。跨域 SSO、iframe 或验证码由人工处理，不猜测选择器、不重复提交。Cookie 为 host-only 根路径；需要复杂跨域存储时使用已批准的节点状态快照。

准备阶段单独两分钟、每执行最多一次，不能占用业务动作、模型次数或清理三分钟。先核验恢复状态；缺失/失效时清除该源的本地存储后尝试配方。至少一个正向 `text` 条件及所有自动条件满足才认为自动核验成功；有 `manual` 条件仍须人工确认。失败转逐步门禁/HITL，后续独立步骤继续。业务执行前重新观察并核验，准备成功不等于验收通过。

快照仅在自动核验通过（无人工条件）或人工完成后更新；失效快照按版本删除，不覆盖其他会话的新状态。每次复用均重新核验。业务 cleanup 可执行退出，但本地状态删除不代表服务端登出；物理 profile 关闭后才释放账号。

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

`pnpm test:api` 使用独立 PostgreSQL 验证版本、选择租约、私密投递和 HITL 终态；`pnpm test:agent` 验证选择工具和执行门禁；`pnpm test:console` 验证六字段表单及原因呈现；`cargo test --locked -p proofrun-node` 验证复制和版本隔离。配置固定版本的 `PROOFRUN_AGENT_BROWSER_BIN` 与 `PROOFRUN_CHROME_BIN` 后运行 `pnpm test:identity:profile`，在真实 Chrome 回环站点验证 Cookie 注入、人工发布与重启、普通任务不污染基准、身份隔离。测试不代表生产站点账号或 Linux 部署已经验收。
