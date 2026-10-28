# Codex / Chromium 真实 MCP 联调

此入口启动真实 API、PostgreSQL、Rust Node、systemd 会话及 Chromium，由真实 Codex CLI 通过两套 Streamable HTTP MCP 判断和操作页面。页面是本地可审计的业务夹具；不使用脚本模型、SimulatedNode 或预设决定，亦不验收外部站点、DevPass、生产 TLS 或模型稳定通过率。

## 运行

需要已登录的 Codex CLI、可创建独立数据库的 PostgreSQL，以及预先准备好的 Linux/systemd 容器。默认复用 `proofrun-preview-runtime-1` 的依赖环境，但创建独立节点目录、身份、资源池和进程，不重启现有服务。容器须将当前仓库只读挂载为 `/workspace`，具备 `/usr/local/cargo/bin/cargo`、锁定版本依赖缓存、普通用户 proofrun、用户 systemd、原生 agent-browser 0.38.1 及 Chromium。

```sh
PROOFRUN_TEST_DATABASE_URL=postgresql://mac@127.0.0.1:5432/postgres \
PROOFRUN_CODEX_BIN=/absolute/path/to/codex \
pnpm test:mcp:codex
```

桌面环境未指定 CLI 时使用 `CODEX_APP_RUNTIME_CLI_PATH`，再回退 PATH 中的 codex。可选 `PROOFRUN_CODEX_MODEL` 明确被测模型，否则使用 Codex 默认模型。`PROOFRUN_REAL_CONTAINER`、`PROOFRUN_REAL_ENGINE_BIN`、`PROOFRUN_REAL_NODE_BIN` 可指定已有环境；省略 NODE_BIN 时自动离线编译当前源码到专用 `/target/mcp-real-current`，不覆盖旧节点二进制。默认 Chromium 包装器为容器中的 `/opt/proofrun/chromium-proxy`，清除环境代理并调用 `/usr/bin/chromium`。API/页面默认端口为 4141/4142，可用 `PROOFRUN_REAL_API_PORT` / `PROOFRUN_REAL_SITE_PORT` 调整。

独立 API 需容器通过 `host.docker.internal` 可达。专用字节转发进程让节点使用容器回环地址配对、连接和上传证据。开发写操作显式启用 `allow_unverified_writes`；一次保存的审计只证明本次运行次数，不证明引擎在断线重试时具备 exactly-once。

## Codex 配置及验收

每轮生成 `.proofrun/mcp-real/<id>/codex.config.toml` 和权限 0600 的 `client.env`。两个端点分别使用同一 principal 的两个 token，具备本例需要的 control/submit/read/evidence/cancel 权限。CLI 用相同配置参数启动，忽略用户配置，关闭 shell 和多 Agent 工具，仅使用本次两套 MCP；不会修改全局 Codex 配置。测试 prompt 单独保存在 [prompt.md](prompt.md)。

写工具需要为这两个已授权测试端点配置 `default_tools_approval_mode="approve"`。仅设置 `approval_policy="never"` 会拒绝默认需要批准的写调用，不能完成提交。[OpenAI 的 MCP 配置说明](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) 定义了 HTTP token 环境变量、required、工具超时及按服务器批准策略；这不改变 ProofRun 的服务端权限校验。

每轮完整 Case 的原定义保存在 `case.json`：准备确认空页面 → CHECKING 核对原 policy → 填写并保存 MCP-REAL-001 → record/finish 验证 → 删除记录并 finish 清理 → 读取报告及 closureVerified。宿主只负责配对、启动及事后核验，不代替 Codex 提交 Case 或决定。

验收须同时满足：

- Codex 事件中成功调用两套 MCP，原样提交 Case，观察到四个阶段，实际接收原生截图，并读取已关闭的最终上下文。
- 平台仅有一个 external 运行，三个步骤均 COMPLETED，报告 PASSED，物理会话关闭；无内置模型调用。
- 页面服务独立记录一次 POST 和一次 DELETE，删除的是这一条记录，最终列表为空。
- 没有通过其他工具绕过 MCP，也不能以最终自然语言宣称成功代替实际事件。

`.proofrun/mcp-real/latest` 指向最近一次输出目录。保留 `report.json`、`audit.json`、`codex.jsonl`、`codex-final.txt`、`versions.json`、真实证据及独立数据库供复核；这些内容被 Git 忽略，可能包含页面数据，不能公开凭据文件。脚本退出会停止本次 API、页面、节点和转发进程；测试端点随之关闭，生成的配置只对应该轮服务。成功与否以审核器退出状态和 audit 为准。

`pnpm test:mcp:regression` 不使用真实模型，检查审核器不会接受缺失阶段、重复写入、未清理或未关闭的假成功，并验证本地启动器能将 MCP 凭据配置传给实际 API 配置加载器。其通过不能替代上述真实联调。
