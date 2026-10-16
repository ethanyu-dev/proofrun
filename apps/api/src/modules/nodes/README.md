# 节点接入

registry.ts 管理一次性配对、凭据归属；gateway.ts 管理主动连接、有限帧队列、结果持久化后的 ACK。撤销由协调器同步结束关联任务，断连本身不能释放浏览器容量。

## 节点默认 profile

Console 的“执行节点 → 默认 profile”允许输入 HTTP/HTTPS 地址，打开独立维护浏览器。画面、点击、输入、导航与 Cookie 操作复用 HITL；创建、恢复、关闭接口和操作连接均要求 Console 管理员凭据，不签发任务专属处理链接。点击“保存并关闭”发布该节点的默认模板并等待浏览器关闭确认；“不保存并关闭”只回收本次副本。

`profiles.ts` 使用现有持久执行、命令账本、短节点租约与关闭确认机制。维护会话不交给 Agent，也不进入业务任务列表；每节点最多一个未关闭的维护会话，占用正常浏览器容量。授权固定三十分钟，重连不延长；到期、撤销或放弃维护都不自动保存。断线后从节点管理恢复原会话，未知保存结果只查询原命令，不自动重放。

节点须上报 `nodeProfileManagement`，因此 API、Console 与 Browser Node 需要一起升级。默认模板以不可变版本保存于节点私有 `auth/node-default-template.profile/`，不改写运维配置的 `base_profile_directory`。新身份优先使用自身基准，其次使用托管默认模板，最后回退到配置目录或空 profile；同一对照轮次固定模板版本。无 Cookie 种子时保留模板登录，显式 Cookie 种子会先清除目标源状态再覆盖。已有身份基准和活动任务副本不会随模板更新改变。

接口：`GET/POST /v1/nodes/:id/profile` 查询当前会话或创建；`GET /v1/node-profiles/:id` 查询状态；`POST /v1/node-profiles/:id/close` 不保存关闭；`/v1/node-profiles/connect` 在 WebSocket 首帧验证 Console 凭据。正常 HITL 入口拒绝这些维护会话。

## 运行版本

节点可在心跳中上报 `runtime`（完整版本、源码提交、引擎版本）。控制面持久保存最近心跳值，旧节点省略时写为 null，避免回退后保留之前版本；离线状态只表示最后上报的版本。会话分配时将版本冻结到 `pr_sessions.node_runtime`，任务查询不关联节点当前值回填历史。该信息只用于诊断，不取代能力声明或授权。
