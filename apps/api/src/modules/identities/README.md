# 测试身份

新建 v2 case 可提供 `session`；省略时创建不恢复历史站点登录态的人工会话。历史任务没有 `sessionPlan`，继续使用原冻结规则。

```json
{"session":{"mode":"identity","identityRef":"team-member"}}
```

模式：`guest` 使用干净 profile 且不保存认证；`manual` 使用任务私有槽；`identity` 指定身份；`pool` 使用 `poolRef` 分配账号池；`auto` 通过站点规则选择。自动规则按环境、节点池、精确主机/子域通配、路径边界匹配；冲突不会猜测账号。

`PROOFRUN_IDENTITY_CATALOG_FILE` 指定平台元数据 JSON：

```json
{
  "identities": [{
    "id": "team-member", "label": "团队成员测试账号", "accountKey": "test-user-1",
    "origins": ["https://example.test"], "maxConcurrent": 1,
    "checks": [
      {"id":"team","description":"处于测试团队","method":"text","value":"测试团队"},
      {"id":"role","description":"账号为非所有者且未绑定 GitHub","method":"manual"}
    ]
  }],
  "pools": [{"id":"members","identityRefs":["team-member"]}],
  "sites": [{"id":"example","hostname":"example.test","environment":"production","nodePool":"internal","poolRef":"members"}]
}
```

元数据不接受密码或 Cookie。`nodeId`/`stateId` 可成对引用已有节点快照；不配置时创建身份专属槽，缺少状态则等待人工登录。前置条件的 `text`/`absent` 使用实际观察，`manual` 使用当前控制代次的人工确认；展示名不能替代角色证明。case 的 `session.requirements` 和步骤 `preconditions` 可追加条件，不能覆盖平台同名条件。

账号占用按全局 `accountKey` 计算，身份别名及对照组不绕过限制。事务内分配，任务结束但浏览器未确认关闭时仍保留占用。只有明确支持多会话的账号才提高 `maxConcurrent`；这不是浏览器 profile 数量。
