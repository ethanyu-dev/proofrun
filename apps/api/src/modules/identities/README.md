# 测试身份

新建 v2 case 可提供 `session`；省略时创建 `manual` 会话；平台开启 `reuseAuth` 时恢复按环境、节点池和站点隔离的登录状态。历史任务没有 `sessionPlan`，继续使用原冻结规则。

```json
{ "session": { "mode": "identity", "identityRef": "team-member" } }
```

模式：`guest` 使用干净 profile 且不保存认证；`manual` 在开启登录复用时使用本站槽，明确关闭复用时仅保存本轮人工登录的私有槽；`identity` 指定身份；`pool` 使用 `poolRef` 分配账号池；`auto` 通过站点规则选择。自动规则按环境、节点池、精确主机/子域通配、路径边界匹配；冲突不会猜测账号。

Web Console 主导航的「测试身份」（`#/identities`）提供以下配置来源：

- **外部身份库**：填写元数据接口 URL 与 Bearer 令牌，验证连接后保存。已保存令牌留空保留，更新地址须重新填写。目录、账号池、站点规则由外部提供方维护，页面只读展示并支持手动刷新。
- **在页面维护**：以表单添加和编辑身份、页面核验条件、账号池及站点规则，一次保存完整目录。可复制已读取的外部目录；修改不回写外部库。
- **使用部署配置**：恢复服务启动时的文件/环境变量配置，页面配置不再覆盖它。

页面配置优先于部署默认值。元数据与版本保存在 PostgreSQL；保存即时影响新 case 与重跑，已提交的 case 仍沿用冻结计划。后台统计刷新不覆盖编辑草稿，多人保存通过版本校验防止互相覆盖。验证连接只检查元数据协议，不执行网站登录。任务仍需指定 `session.mode` 为 `identity`、`pool` 或 `auto` 才会使用目录。

页面写入的外部库令牌放在 API 私有目录：默认 `PROOFRUN_ARTIFACT_DIRECTORY/.identity-secrets`，可用 `PROOFRUN_IDENTITY_SECRET_DIRECTORY` 指定持久目录；目录权限 `0700`、文件 `0600`。数据库只存随机文件引用，接口只回显是否配置，不回传令牌或文件路径。该目录不注册为证据，也不属于证据清理范围。备份和迁移需同时保留数据库与私有目录；API 主备应挂载同一持久卷。令牌轮换或切换来源成功后删除被替换的文件，结果未知时保留文件并先重新读取配置核查。

Web 管理的是外部元数据连接与身份目录。网站密码、Cookie 及 Browser Node 凭据提供方仍在节点私有配置中维护，表单只填写 `loginRef`；不会把密码或 Cookie 写入身份目录、任务或模型上下文。

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

部署先更新 API 与 Agent，再升级 Browser Node，最后启用命名身份配置；未声明 `identityPreparation` 的旧节点不会领取命名身份任务。新协议需三端一起升级，普通历史任务保持原行为。首先为一个测试域名配置身份与角色条件，再用 `session.mode=identity` 验证，最后启用域名规则和账号池。

验证命令：`pnpm test:api`（需独立 `PROOFRUN_TEST_DATABASE_URL`）、`pnpm test:agent`、`pnpm test:console`、`cargo test --locked -p proofrun-node`。真实浏览器夹具使用 `PROOFRUN_AGENT_BROWSER_BIN`（固定 0.38.1 原生二进制）、`PROOFRUN_CHROME_BIN` 后运行 `pnpm test:identity:browser`；只验证回环站点的 Cookie、密码、快照、访客隔离与外部提供方协议，不代表生产账号已配置或真实网站验收通过。

身份配置的正向条件应包含能唯一识别账号的页面标记，再追加团队及角色条件；仅有“已登录”或通用团队名称不能证明实际账号与 `accountKey` 一致。不能通过可靠页面标记确认的条件使用 `manual`，不推测角色。

未指定身份的 v2 与旧内部任务使用同一本站登录槽。双跑共享初始快照和所属节点，后续浏览器会话独立；新一轮任务使用新的初始快照。恢复登录不证明账号角色符合当前 case，仍需检查页面或人工确认。
