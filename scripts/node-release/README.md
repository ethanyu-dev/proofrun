# Browser Node 发布、安装与升级

本入口只安装 Linux Browser Node 和固定版本的 agent-browser 原生引擎。API、Web、执行 Agent 与 PostgreSQL 使用 [Railway 配置](../../deploy/railway/README.md)，不安装到节点机。

## 构建 release

在 GitHub Actions 选择 **Build Browser Node Release → Run workflow**，输入与 `Cargo.toml` 一致的版本，例如 `node-v0.1.0-alpha.1`。工作流分别在 x64 / arm64 构建 Debian 12 基线的 release 二进制，运行安装器回归、校验引擎摘要，最后创建 **Draft / Pre-release**：

- `proofrun-node-linux-x64.tar.gz`
- `proofrun-node-linux-arm64.tar.gz`
- `install.sh`、`install-node.py`
- `SHA256SUMS`

检查两种架构构建与资产后，在 GitHub Release 页面发布草稿。同版本已有 release 时工作流拒绝覆盖；升级应提高 Cargo 版本或预发布后缀。API / Web / Agent 的 Railway 发布不依赖节点 tag。

发布工作流将完整 release 标签及源码 SHA 编译进程序，打包前运行 `proofrun-node build-info` 与 `release.json` 核对，防止旧二进制被贴上新标签。`--version` 显示完整 release 标签；未注入构建身份的本地程序显示 `0.1.0-dev`，提交为未知，不读取安装目录推断版本。

从 alpha.6 起，节点心跳携带运行版本、源码提交和固定引擎版本。**先部署支持 `node.heartbeat.runtime` 的 API 与 Console，再升级节点**；旧 API 会拒绝新增心跳字段。节点页显示最近上报版本，任务详情冻结分配会话时的节点版本，旧节点及历史任务显示“未上报”。节点离线时保留最后上报值；更新安装目录后必须重启进程，上报版本才会变化。

预发布版本需显式指定下载 URL 和 `--version`；GitHub `latest` 不包含预发布。[node-v0.1.0-alpha.1](https://github.com/ethanyu-dev/proofrun/releases/tag/node-v0.1.0-alpha.1) 已于 2026-09-29 发布，下方固定版本的下载命令可用。摘要校验保证资产完整性，不等于独立签名或 VM 验收。

## ALB 节点代理检查与修复

已使用 ALB 终止 TLS、转发到节点 HTTP 9444 的部署，可在对应 Linux 节点执行 `repair-node-proxy.sh`。它检查 Node 回环 9310、Nginx 9444 和公网三个 WebSocket 入口；默认只检查，`--apply` 修复已有托管配置或在空闲 9444 上建立代理。需要已安装 Nginx、curl 和 systemd，不重启 Browser Node，也不修改 ALB、安全组、节点身份或会话。

```sh
sudo bash repair-node-proxy.sh --domain agent-browser-runtime.pplabs.tech --apply
```

原有托管配置保存在 `/var/backups/proofrun-node-proxy-*`，本机验证失败自动恢复；未识别的配置和端口占用会拒绝覆盖。退出码 0 表示本机及公网握手通过，1 表示本机检查或修复失败，2 表示本机通过但公网失败；后者保留已验证的本机配置，并输出 ALB 目标协议 HTTP、端口 9444、健康检查 `/healthz` 的核对项。握手通过后仍需在 Console 重新连接并确认收到实际首帧，不能把握手检查当成画面验收。

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
| `~/.config/proofrun/node.toml`                 | 网关、直连地址、浏览器和资源准入配置     | 保留，不覆盖         |
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

## 直连版本配置迁移

当前源码安装器新增 `--public-url https://browser-node-01.example.com`，将地址写入 `~/.config/proofrun/node.toml`。生产 HTTPS 域名、TLS 代理和 `listen` 配套配置见[节点直连部署](../../deploy/README.md#节点直连域名与升级)。上文历史 release 命令仅说明已有发行包，不包含这次尚未发布的改造。

升级已有安装前，停止派发并确认会话清理；手动删除旧 `capacity`，填写 `public_url` 和 `listen`，按实际内存调整余量。安装器保留配置，不替用户迁移资源策略。API/Console 与 Node 必须按同一协议升级；仅在线不代表域名、证书与客户端网络已经通过验证。

多控制面节点的授权保存在同一个 `home/node.db`，安装器保留并识别注册表。升级前排空所有绑定；旧单控制面可停机执行 `bindings import-legacy` 原样导入，再热添加其他服务，操作见[多控制面部署](../../deploy/README.md#一个节点授权多套控制面)。SQLite 升级后不能只切回旧二进制。

## 减少动画默认值的发布

动画偏好由 Browser Node 内的 Rust 引擎适配器设置，本次修复需要构建新的节点 release 并升级节点；只发布 Railway API/Web/Agent 不会改变旧节点的浏览器启动行为。固定 agent-browser 仍为 0.38.1，无需升级上游引擎。

先发布包含 `reducedMotion` 协议与能力识别的 API（以及配置展示的 Web），再排空并按本文安装流程升级 Browser Node。升级窗口内，带动画偏好配置的任务会等待支持该能力的节点，不能静默回退到正常动画。现有已打开会话不会热修改；升级后新建任务和重跑创建的新会话生效。Agent 无新增执行逻辑，但保持同一发布版本即可。

使用新的 `node-v0.1.0-…` 版本号触发 `release-node.yml`，核对 x64/arm64 资产、摘要及 build-info 后发布草稿；不覆盖已有 alpha.16 资产。升级后确认心跳包含 `capabilities.reducedMotion=true`，并在新执行的启动结果中确认 `environmentProof.reducedMotion=true`。动画验收可在 case 的 session 中明确设为 false，具体契约见[结构化 Case API](../../docs/public-api-v2.md#浏览器动画偏好)。

## 运行时取证与会话恢复升级

运行时取证需要同时更新 API、Agent、Console 和 Browser Node。先部署包含 migration 038 的 API 及同版本 Agent/Console，再排空节点上的所有绑定并发布、安装新的节点版本；不能覆盖已有 alpha.17 资产。旧节点仍可接普通 DOM 用例，需要新增能力的用例会明确报告 `CAPABILITY_UNSUPPORTED`，不会退化为人工打开 DevTools 或一直排队。

升级后核对心跳的 `runtimeEvidenceVersion=1`、`networkDetailsVersion=1`、`focusRecoveryVersion=1`。新会话的观察应产生独立 `RUNTIME` 附件，包含当前 origin 的 Service Worker、缓存元数据和限定范围的 Console 记录。缓存正文、Cookie 和任意脚本不在探针接口内。图片参数探测只改变已观察站内图片的质量，使用不带账号凭据的公开请求，不能替代浏览器登录会话响应。人工页的“读取运行时证据”只读且不代填待办确认。

焦点恢复仅在收到明确“按键未发送”的节点回执时有效，恢复前强制重新观察；传输未知仍停止。人工等待显示实际截止时间，四小时链接有效期不代表会话可等待四小时。管理员 execution activity 的 `renewals` 返回最近 20 次续租的创建、首次投递、确认状态、授权延迟和剩余时长，可区分排队、传输和真实到期；不返回执行令牌。

本地真实 Chromium 回归需显式设置独立浏览器路径：

```sh
PROOFRUN_TEST_CHROME=/path/to/chromium cargo test --locked -p proofrun-node native_ -- --ignored
pnpm test:node:linux
pnpm test:hitl:linux
```

这些测试验证本地夹具和协议链路。生产验收仍需在升级后重跑原用例，核对实际 SW、缓存边界、账号准备及最终报告；不得为取得通过结果修改原始业务标准。
