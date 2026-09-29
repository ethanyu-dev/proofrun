# 变更记录

## 未发布

- 将 Agent 系统提示、JEV 提示和上下文构建拆分到独立模块，保留执行与证据边界。
- 整理运行、架构与测试文档，将维护说明集中到部署文档，移除阶段性验证记录。
- 增加正式域名下的 Swagger UI 和 OpenAPI JSON，覆盖公共 Case API v1/v2。
- 修复部署测试中 PostgreSQL 临时启动阶段被误判为就绪的问题，改用 TCP 探测。

## Browser Node node-v0.1.0-alpha.1 — 2026-09-29

- 已发布 [预发布版](https://github.com/ethanyu-dev/proofrun/releases/tag/node-v0.1.0-alpha.1)，源码提交为 `9888814e5e8daa0cd314dbb6f294d0540be21411`；未标记为稳定版或 latest。
- 提供 Linux x64 / arm64 节点包、固定的 agent-browser 0.38.1 引擎、安装脚本与 SHA-256 校验文件。API、Web、执行 Agent 和 PostgreSQL 由 Railway 独立部署，不包含在节点安装包中。
- 节点包以 glibc 2.36+ 为支持基线；配对和在线检查不替代真实业务、浏览器写入和故障恢复验收。

### 发布准备

- CI 的 checkout、setup-node 和 pnpm Action 升级至 Node 24 运行时，并固定到已核对的发布提交。
- 增加独立 Linux 浏览器检查，覆盖真实 Chromium、登录状态、人工介入、DOM 能力与 systemd/网关故障；模型仍使用本地脚本。
- 固定 agent-browser 0.38.1 的 Linux 下载资产与 SHA-256，拒绝未知版本或摘要不匹配的文件。
- Agent/API 集成测试允许导航后的有界补采，逐份检查证据下载、摘要、媒介和验收引用。
- 修正 Linux 测试入口在 macOS Bash 3 严格模式下展开空数组的问题。
- 修复 HA 测试结束时断连与强制删库的竞争；HITL/TRACE 夹具增加独立 worker 心跳和跨初始租约回归，保留无心跳时的过期检查。
- 修复单实例与 HA 的 Caddy 模板遗漏 `/v2/*` 转发的问题，避免 Case API v2 被 Console 页面兜底。
- 增加编译产物的部署入口冒烟检查，验证实际 Caddy 路由、静态资源、空库迁移和 API 重启持久化，并纳入 CI。

生产写入验证、真实业务质量和部署验收以 [部署与运行维护](deploy/README.md) 为准；预发布及本记录不能替代这些验收。
