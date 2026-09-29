# Browser Node 本地调试页

这个页面用原生 `proofrun-node` 二进制的内部 `session-host` 驱动独立 Chrome。它适合在 macOS 上直接核对浏览器适配层；Linux 上也可用。页面只监听 `127.0.0.1`，一个调试服务同时只运行一个会话。

## 启动

需要 Node.js 24、Rust 工具链、Chrome/Chromium，以及固定版本 `0.38.1` 的 **原生** `agent-browser` 可执行文件。仓库里的 npm 启动脚本或其他版本不能替代它。

```sh
PROOFRUN_AGENT_BROWSER_BIN=/absolute/path/to/agent-browser-darwin-arm64 \
PROOFRUN_CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
pnpm dev:node:browser
```

然后打开 <http://127.0.0.1:8765>。Linux 环境把两个二进制路径改成对应架构的原生引擎和 Chromium 路径。可通过 `PROOFRUN_DEBUG_PORT` 调整本地端口，或通过 `PROOFRUN_TEST_BINARY` 指定已构建的节点二进制。

1. 点击“启动会话”。
2. URL 默认指向内置 `/fixture`，点击“跳转并查看”。
3. 在 `ref / target` 中选择 `textbox · 姓名`，输入任意值后点击“填写”。
4. 选择最新观察里的 `button · 保存`，点击“点击”。
5. 在 DOM 快照和截图中检查“已保存”与点击次数；在日志里检查每条 `run` 输入及 `host.result` 输出。

每次动作后自动重新观察并截图，因为旧 `observationId` 和 target 在动作后失效。页面显示的 `element-N` 是 Browser Node 对引擎 ref 的临时映射；真实 CLI ref 留在适配层。截图是采样画面，不是持续视频流。会话目录位于系统临时目录，关闭会话时删除。

## 验证边界

调试页启用 `allow_unverified_writes`，仅用于受控测试页面。它绕过控制面、网关、SQLite、systemd 会话监管及证据上传，不能用于判断完整节点部署或引擎在响应丢失时的写入重试行为。完整 Linux 节点与控制面测试见 [测试入口与覆盖边界](../../README.md)。
