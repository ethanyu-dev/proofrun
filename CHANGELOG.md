# 变更记录

## 未发布

### 发布准备

- CI 的 checkout、setup-node 和 pnpm Action 升级至 Node 24 运行时，并固定到已核对的发布提交。
- 增加独立 Linux 浏览器检查，覆盖真实 Chromium、登录状态、人工介入、DOM 能力与 systemd/网关故障；模型仍使用本地脚本。
- 固定 agent-browser 0.38.1 的 Linux 下载资产与 SHA-256，拒绝未知版本或摘要不匹配的文件。
- Agent/API 集成测试允许导航后的有界补采，逐份检查证据下载、摘要、媒介和验收引用。
- 修正 Linux 测试入口在 macOS Bash 3 严格模式下展开空数组的问题。

当前没有已发布版本。生产写入验证、真实业务质量和部署验收以 [发布检查表](docs/release-readiness.md) 为准；本记录不能替代这些验收。
