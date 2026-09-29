# 部署

此目录提供 PostgreSQL Compose、节点 TOML、API/Agent/Node 的 systemd 用户服务和 Caddy 同源代理模板。没有自动安装器，模板尚未经过真实内网 VM 验收。

首次交付、版本追溯、业务验收和备份恢复演练统一按 [发布检查表](../docs/release-readiness.md)执行；CI 的容器回归不代替目标 VM 的部署验收。

目标部署单元：

- 控制面：API、数据库、队列协调、证据对象存储。
- 验证执行 Agent：独立 worker，由模型配置和吞吐需求决定副本。
- Console：静态资源。
- Browser Node：部署在可访问业务环境的 VM，主动连接控制面，运行 Chrome 和 agent-browser。

已完成 systemd 容器内的控制面与节点闭环，真实 Linux 内网 VM 仍需验收，再固化生产镜像与运维流程。不从旧项目直接复制带历史假设的部署脚本。

节点准备：以独立普通用户运行；管理员为该用户启用 linger，创建其可写的 `/var/lib/proofrun`；将固定版本的原生 agent-browser、proofrun-node 与 Chrome 安装到配置指定位置。将 node.example.toml 调整后放到 `/etc/proofrun/node.toml`，凭据保存在节点 home 下的 credential.json（0600）。

将 proofrun-node.service 安装到运行用户的 `~/.config/systemd/user/`，在该用户的 systemd 会话中执行：

```sh
systemctl --user daemon-reload
systemctl --user enable --now proofrun-node.service
journalctl --user -u proofrun-node.service -f
```

apps/api 已提供 `/v1/nodes/connect` 网关与 `/v1/artifacts` 上传服务，控制面启动和节点配对见 [API 说明](../apps/api/README.md)。API 当前只允许一个活动实例；PostgreSQL 与截图目录均需持久化。测试容器与启动脚本位于 tests/browser-node；其 privileged 权限仅用于容器内部 systemd/cgroup 演练，不是生产部署建议。

## 控制面与执行 Agent

在 `/opt/proofrun` 安装锁定依赖并执行 `pnpm build`。API 与 Agent 的用户服务分别读取 `/etc/proofrun/api.env` 和 `/etc/proofrun/agent.env`，变量以根目录 `.env.example` 为准；文件仅运行用户可读。运行用户需要持久证据目录和数据库权限；worker 只需连接控制面与模型服务。模型地址、型号与密钥没有默认值。

复制相应 service 到运行用户的 `~/.config/systemd/user/`，执行 `systemctl --user daemon-reload` 和 `systemctl --user enable --now proofrun-api.service proofrun-agent.service`。生产环境按实际 Node.js 24 安装位置调整 ExecStart。Caddyfile 中的 PROOFRUN_DOMAIN 由服务环境提供；静态 Console 与 `/v1/*` 在同一个 HTTPS origin，节点使用同源 WSS，无需反向访问内网。

备份范围为 PostgreSQL、API 证据目录、节点 home（含身份、SQLite、凭据与登录状态）；数据库和证据应在停止写入后一起备份，恢复到同一版本。维护默认只预览；配对回执恢复、轮换、清理和重启处理见 [运行手册](../docs/migration-completion.md)。不要用测试容器的 privileged 配置作为生产部署方式。
