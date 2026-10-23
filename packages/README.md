# DevPass 协议与客户端

`devpass-contracts` 与 `devpass-client` 固定来自同级 DevPass 仓库提交 `0ab8702a` 的 `packages/contracts/src` 和 `packages/client/src`，协议版本为 `1`。源码随 ProofRun 一起构建，部署不依赖相邻检出目录、未发布包或网络拉取分支。

本地客户端增加 PostgreSQL `JournalStore`、按接收 key ID 解析私钥、十秒请求超时，以及指定账号/材料类型/角色绑定检查。协议 schema 与生成类型保持上游内容；更新上游时一起同步并运行 ProofRun 的外部账号集成测试。`pnpm build:devpass` 按依赖顺序构建两个包；API 的安装和部署使用 workspace 依赖。

适配器在 `apps/api/src/modules/account-providers`，使用方式见身份模块 README。数据库不保存材料或 JWE，SDK 账本必须在外部请求前提交。客户端断开连接不等于释放账号，只有调用方确认浏览器停止后才能 `releaseStopped`。
