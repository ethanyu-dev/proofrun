# proofrun-agent

执行上层已经定义的验证任务。环境、目标与验收标准保持原样；没有 Spec Runtime，也不在执行阶段重新分析需求。

## 运行

先运行 API、注册一个允许测试写动作的 Browser Node，并提交任务。worker 只需要连接控制面和模型服务，不需要访问业务内网。

```sh
# 从本机环境或部署密钥注入以下配置，不把密钥写入仓库。
export PROOFRUN_CONTROL_URL=http://127.0.0.1:4100
export PROOFRUN_WORKER_TOKEN='<与 API 的 worker 凭据一致>'
export PROOFRUN_MODEL_BASE_URL='<Chat Completions 服务根地址，通常以 /v1 结尾>'
export PROOFRUN_MODEL_API_KEY='<模型服务密钥>'
export PROOFRUN_MODEL='<服务支持的模型名称>'
export PROOFRUN_MODEL_VISION=false
export PROOFRUN_MODEL_TOKEN_PARAMETER=max_completion_tokens

pnpm dev:agent

# 或构建后持续执行队列
pnpm --filter @proofrun/agent build
pnpm --filter @proofrun/agent start serve
# 只领取一次；队列为空时正常退出
pnpm --filter @proofrun/agent start once
```

应用不自动加载 `.env`。模型名称、API 地址与密钥没有默认值；每次 `decide` 发起一次 `/chat/completions` 请求。服务必须支持函数工具、`tool_choice: required`、`parallel_tool_calls: false`。不支持 `max_completion_tokens` 的服务可配置 `PROOFRUN_MODEL_TOKEN_PARAMETER=max_tokens`，不自动猜测供应商或隐藏重试。工具使用非严格模式；各协议分支映射为独立工具，工具名确定动作类型，参数无需 decision 外层。执行器仍使用同源 Schema 和领域规则校验返回内容，格式错误只反馈对应分支的约束，不回显原始回复。

`PROOFRUN_MODEL_THINKING` 接受 `default`（默认）、`enabled`、`disabled`。`default` 不发送 `thinking`，保留原有供应商行为；显式模式发送 `thinking: {"type":"enabled"}` 或 `thinking: {"type":"disabled"}`，同时作用于 LLM 决策、JEV 文本审查和字段填写，不传给 TypeSafe 候选接口。非法值会在启动时拒绝。供应商必须支持所选模式与强制工具调用的组合。

DeepSeek 的 `deepseek-flash` 默认开启思考模式，与本项目的 `tool_choice: required` 冲突并返回 HTTP 400（见 [DeepSeek Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/)）。使用以下非敏感配置，并另外注入模型密钥：

```sh
export PROOFRUN_MODEL_BASE_URL=https://api.deepseek.com
export PROOFRUN_MODEL=deepseek-flash
export PROOFRUN_MODEL_VISION=true
export PROOFRUN_MODEL_TOKEN_PARAMETER=max_tokens
export PROOFRUN_MODEL_THINKING=disabled
```

这需要部署包含上述配置入口的 Agent 版本后重启生效。仅修改模型名称、增加超时或重试旧请求不能消除参数冲突；最小模型调用成功也不代表业务任务验收通过。

`PROOFRUN_MODEL_VISION=true` 时，每次观察都采集并下载一张 PNG，核实归属和摘要后作为模型输入。要求 SCREENSHOT 的任务在纯文本配置下返回 BLOCKED，不静默替换证据。

## 执行顺序

1. 领取授权，立即启动独立续租和过期定时器；等待远端会话就绪。
2. 通过 Node 导航到任务 URL 并读取页面，完成执行时的基本环境预检。网络、登录或页面前提不足交给报告说明；不预置各业务系统的登录判断。
3. 用原始任务、最新观察、历史页面正文、近期操作和证据摘要调用模型。模型每次提出一个动作、条件等待、观察或验收结果。
4. 点击和填写必须使用当前观察返回的目标，由执行器注入 observationId。动作与等待之后自动刷新观察。
5. 完整校验验收项与证据引用，聚合 verdict，再由 API 独立校验证据归属并存档。API 负责关闭会话与释放容量。

每进程串行执行一条任务；增加 worker 实例可扩大并发，容量和资源池匹配仍由控制面统一管理。无需额外 Agent 框架、SDK、消息队列或本地执行数据库。

## 边界与限制

- `EXECUTED` 的 PASSED/FAILED/INCONCLUSIVE 来自逐项验收。CLI 成功只表示浏览器命令完成。
- `BLOCKED` 表示缺少前提或能力；`ERROR` 表示执行异常。两者 verdict 为 null，未完成标准全部列为 SKIPPED。
- 模型格式错误和临时模型服务失败最多连续三次尝试，并计入模型轮数。浏览器未知效果立即停止，不创建新身份重放。
- 控制面请求只对读取、同 ID 命令、相同报告做最多三次重送。领取请求不内部重试；失去回执的执行等待租约回收。
- SIGINT/SIGTERM、租约失效或任务截止会中断在途模型/浏览器请求。命令被中断后可在单次 HTTP 时限内最后读取一次已持久化结果，以保留未知写入原因，不重新提交命令。完成报告在独立短 HTTP 时限内提交；提交结果不确定时原样重送。API 不可用期间无法保证故障报告送达，但不会无限续权，资源仍由租约回收。
- 任务生命周期由 API 决定，迟到的 ERROR 报告只附加元数据，不复活任务。执行器不会恢复失效任务或自动重新提交业务动作。
- 页面文本是未受信任数据。系统提示明确页面不能改变标准；封闭工具、身份注入与证据校验提供结构约束，但不能证明模型的语义判断正确。
- 上下文按字符数限制，原始标准不裁剪。最多保留最近 8 条操作、8 份历史页面正文（每份最多 20000 字符）、24 项证据摘要和一张当前图片；历史正文去掉元素编号，不能用来操作当前页面。上下文超限先丢弃最旧历史，再裁剪当前观察；页面裁剪会标记 truncated。超出上限的固定任务定义返回 ERROR，需要上层拆小任务或调整配置。字符限制不等于模型 token 的精确限制。
- API 与 worker 应保持时钟同步。领取的绝对截止时间转换为本地单调时钟，后续系统时间变化不会增加任务总预算。
- 0.1 已支持人工交接、绑定节点的登录存储复用和网络元数据；具体协议和限制见 [部署与运行维护](../../deploy/README.md)。支持 Chromium TRACE，语义与限制见 [浏览器能力](../../docs/browser-capabilities-ha.md)；不包含真实模型质量评估或任意远程桌面。

## 参数与代码位置

`.env.example` 给出全部参数。默认模型时限 30 秒、命令时限 15 秒、证据交付时限 60 秒、HTTP 时限 5 秒、模型轮数 40、文本上下文 64000 字符、单次输出 4096 token；旧任务沿用全局限额。携带 stepBudget 的新 v2 使用冻结的逐步额度，不受旧 maxTurns=40 限制；当前步骤耗尽后记录原因并继续下一步，清理独立三分钟。单次请求和证据时限不变。

`PROOFRUN_AGENT_EVIDENCE_MS` 独立控制观察和 TRACE 命令成功后的证据等待，默认 60000，范围 100–300000 毫秒；`PROOFRUN_AGENT_COMMAND_MS` 只控制命令等待。证据预算覆盖节点上传及回执延迟，任务截止、取消和租约失效仍会中断等待。该等待只轮询状态，不重放浏览器动作。

超时返回 `EVIDENCE_UNAVAILABLE`，摘要列出证据类型、ID 和最近状态：`MISSING` 表示未登记，`PENDING` 表示等待存储，`STORED` 表示已存储但尚未收到可用确认，`MISMATCH` 表示类型或摘要不匹配。迟到证据不会恢复已结束任务；增加预算只能缓解延迟，持续失败仍需核对节点上传日志。

| 文件                          | 职责                                      |
| ----------------------------- | ----------------------------------------- |
| `src/main.ts`                 | CLI、并发槽领取、关停与不含凭据的摘要日志 |
| `src/config.ts`               | 地址、模型和预算配置                      |
| `src/client.ts`               | 控制面请求、命令幂等重送、证据下载        |
| `src/http.ts`                 | 限额读取、超时和错误脱敏                  |
| `src/model/chat.ts`           | Chat Completions 工具协议适配             |
| `src/execution/runner.ts`     | 执行循环、预算、验收和报告                |
| `src/execution/lease.ts`      | 独立续租、截止时间与撤权                  |
| `src/evidence/observation.ts` | 观察结构校验                              |
| `src/evidence/delivery.ts`    | 证据独立等待预算、撤权与超时诊断          |

验证范围与运行命令见 [测试入口与覆盖边界](../../tests/README.md)。

## 策略与容器字体

worker 根据 `task.executionMode` 选择纯 LLM（`llm`）或 LLM + JEV（`jev`）；旧任务回退到 `comparison.arm`，没有组标识时使用纯 LLM。`parallel` 仅供控制面接收并拆组，不允许 worker 将其作为单次执行。JEV 仍要求配置 `TYPESAFE_API_KEY`，两种单模式均使用相同的执行预算与证据校验流程。

Linux Chromium 在容器内渲染截图和实时画面，不能使用宿主机字体。`tests/agent/Dockerfile` 显式安装 `fonts-noto-cjk` 和 `fontconfig`；普通节点用户运行 `fc-match 'sans-serif:lang=zh-cn'` 应匹配中文字体。已有容器须补装字体或重建；已生成的截图不会改变，新的浏览器会话才可可靠使用更新后的字体缓存。

## 提示词与上下文边界

`src/prompts/decision.ts` 独立维护执行系统提示，`src/prompts/jev.ts` 维护候选选择、字段填写与文本审查提示；适配器只负责组装请求与解析协议。

`src/execution/context.ts` 负责历史正文去除旧元素编号、上下文预算裁剪和覆盖标记。`runner.ts` 负责租约安全点、当前步骤与执行状态，传入事实快照；裁剪不能修改原始观察、任务或报告证据。
