# 测试身份

新建 v2 case 可提供 `session`；省略时创建不恢复历史站点登录态的人工会话。历史任务没有 `sessionPlan`，继续使用原冻结规则。

```json
{ "session": { "mode": "identity", "identityRef": "team-member" } }
```

模式：`guest` 使用干净 profile 且不保存认证；`manual` 使用任务私有槽；`identity` 指定身份；`pool` 使用 `poolRef` 分配账号池；`auto` 通过站点规则选择。自动规则按环境、节点池、精确主机/子域通配、路径边界匹配；冲突不会猜测账号。

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
