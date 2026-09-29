# Browser Node 发布、安装与升级

本入口只安装 Linux Browser Node 和固定版本的 agent-browser 原生引擎。API、Web、执行 Agent 与 PostgreSQL 使用 [Railway 配置](../../deploy/railway/README.md)，不安装到节点机。

## 构建 release

在 GitHub Actions 选择 **Build Browser Node Release → Run workflow**，输入与 `Cargo.toml` 一致的版本，例如 `node-v0.1.0-alpha.1`。工作流分别在 x64 / arm64 构建 Debian 12 基线的 release 二进制，运行安装器回归、校验引擎摘要，最后创建 **Draft / Pre-release**：

- `proofrun-node-linux-x64.tar.gz`
- `proofrun-node-linux-arm64.tar.gz`
- `install.sh`、`install-node.py`
- `SHA256SUMS`

检查两种架构构建与资产后，在 GitHub Release 页面发布草稿。同版本已有 release 时工作流拒绝覆盖；升级应提高 Cargo 版本或预发布后缀。API / Web / Agent 的 Railway 发布不依赖节点 tag。

预发布版本需显式指定下载 URL 和 `--version`；GitHub `latest` 不包含预发布。[node-v0.1.0-alpha.1](https://github.com/ethanyu-dev/proofrun/releases/tag/node-v0.1.0-alpha.1) 已于 2026-09-29 发布，下方固定版本的下载命令可用。摘要校验保证资产完整性，不等于独立签名或 VM 验收。

## 节点机一次性准备

支持 Debian 12 / Ubuntu 24.04 及兼容系统，Linux x64 / arm64、glibc 2.36+。需要 Bash、curl、sha256sum、Python 3.11+、systemd 用户管理器和 cgroup v2，以及已安装的 Chrome/Chromium。节点机不需要 Node.js、pnpm 或 Rust 编译器。

使用普通运行用户，不要 sudo 执行安装器。管理员预先安装上述依赖、Chrome/Chromium，并执行：

```sh
sudo loginctl enable-linger <运行用户>
```

在该用户的登录会话确认 `systemctl --user show-environment` 可用。浏览器具体安装方式由系统发行版决定；安装器不会擅自替换现有浏览器或修改系统软件源。

## 首次安装

先在 Console 创建与目标池匹配的一次性配对码，并存放到节点机仅该用户可读的文件（`chmod 600`）。不要把配对码放进命令行参数或提交到仓库。

```sh
curl -fsSL https://github.com/ethanyu-dev/proofrun/releases/download/node-v0.1.0-alpha.1/install.sh -o /tmp/proofrun-install.sh
bash /tmp/proofrun-install.sh \
  --version node-v0.1.0-alpha.1 \
  --api https://proofrun.example.com \
  --pool internal \
  --chrome /usr/bin/chromium \
  --pairing-token-file /private/path/pairing-token
```

`--api` 填 Railway Web 的公开 HTTPS origin。配对成功后移除一次性配对文件。省略 `--pairing-token-file` 可以先安装，服务保持停止；之后使用已安装的 CLI 配对并启动：

```sh
~/.local/lib/proofrun-node/current/bin/proofrun-node \
  --config ~/.config/proofrun/node.toml pair \
  --pairing-token-file /private/path/pairing-token
systemctl --user enable --now proofrun-node.service
```

确认 Console 中节点在线，再运行测试任务。安装器报告服务存活不代表网关在线或浏览器业务通过。写动作仍默认关闭；`allow_unverified_writes` 和生产写入验证边界见节点说明，不由安装脚本自动放开。

## 后续升级

先停止向该节点派发新任务并等待清理完成。重复执行安装脚本，仅更换版本：

```sh
bash /tmp/proofrun-install.sh --version node-v0.1.0-alpha.2
```

下载入口会按选定 release 获取对应安装器和架构包，分别核对摘要。正式稳定版发布后也可使用：

```sh
curl -fsSL https://github.com/ethanyu-dev/proofrun/releases/latest/download/install.sh | bash
```

| 路径                                           | 内容                                     | 升级行为             |
| ---------------------------------------------- | ---------------------------------------- | -------------------- |
| `~/.local/lib/proofrun-node/releases/<版本>`   | 不可变程序和引擎                         | 新增版本，保留旧版本 |
| `~/.local/lib/proofrun-node/current`           | 当前程序指针                             | 检查后原子切换       |
| `~/.config/proofrun/node.toml`                 | 网关、池、浏览器和容量配置               | 保留，不覆盖         |
| `~/.local/share/proofrun-node`                 | 身份、凭据、SQLite、登录状态、会话和证据 | 保留，不删除或重置   |
| `~/.config/systemd/user/proofrun-node.service` | 用户服务                                 | 仅首次创建           |

安装器使用独占安装锁，拒绝摘要错误、架构不匹配、归档越界和同版本资产替换。活动、关闭中或隔离会话都会阻止升级；没有跳过保护的 `--force` 开关。已有其它安装方式创建的同名 service 需要先迁移，安装器不会覆盖其 ExecStart。

切换前失败会保留旧程序，并恢复原先运行的服务。新版本开始启动后若失败，则停止服务并保留新旧程序及全部数据，使用 `journalctl --user -u proofrun-node.service` 诊断。因为启动可能迁移 SQLite，不自动回退程序并猜测数据兼容；需要恢复时应使用升级前同版本的完整节点数据备份。

测试命令：

```sh
bash -n scripts/node-release/install.sh
python3 -m unittest discover -s tests/node-release -p 'test_*.py'
```

这些测试检查真实归档、文件系统和 SQLite，但替代了 systemd 与 doctor 进程边界；不代表真实机器的浏览器、网关重连或版本回滚已经验收。
