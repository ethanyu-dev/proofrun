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

`PROOFRUN_MODEL_VISION=true` 时，每次观察都采集并下载一张 PNG，核实归属和摘要后作为 LLM 输入。JEV 任务也可独立开启 `PROOFRUN_JEV_IMAGES`，仅向 JEV 提供图片；关闭 LLM 视觉时，文本审查不接收图片，也不能执行坐标点击。要求 SCREENSHOT 的任务在当前策略未启用任何图片输入时返回 BLOCKED，不静默替换证据。JEV 看图不等于文本审查已经看过图；仅有截图引用、缺少可核实内容时仍须保留验收缺口。

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
- 节点明确声明目标输入未派发的 DOM 准备故障，Agent 会丢弃旧目标、重新观察并交给模型选择下一步；连续三次失败只阻塞当前步骤，后续业务与清理仍可执行。已派发输入的未知效果仍终止会话，原始故障不会被步骤保存时的撤权错误覆盖。
- `observation.documents` 保留各 frame 的 HTML `lang` 声明；空字符串表示未声明，null 或旧节点缺少该字段表示未知。页面声明与正文语言分别验收，不以重复导航弥补缺失证据。
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

## Jev 版本与实验长上下文

默认固定 `jev-1.14.0`；可用 `TYPESAFE_MODEL` 显式回退到 `jev-1.13.0`。已有环境若配置 `jev-latest`，需要主动改成版本号：截至 2026-10-15，[TypeSafe 官方模型说明](https://docs.typesafe.ai/models)仍将 `jev-latest` 指向 1.13、`jev-preview` 指向 1.14。模型调用回执保存供应商返回的 `model` 字段，便于核对别名实际解析版本。

1.14 的普通文本 Choice 沿用原端点和协议，默认上限仍为每请求 64k、每问题 32k token。1.13 和 1.14 都支持通过 `TypeSafe-Danger-Zone-Long-Context: true` 把两项上限提升到 262k token；这是实验能力，官方说明其延迟和准确率可能劣于短上下文。

`PROOFRUN_JEV_LONG_CONTEXT=true` 允许适配器保留更多当前正文：请求字符保护从 64000 提升到 256000，保守 token 预算从 28000 提升到 224000，当前页正文从 14000 提升到 64000 字符。只有最终请求估算超过普通 token 预算时才发送实验头；短请求、文本填写和验收请求不带该头。开关默认关闭，关闭即可恢复原 Jev 裁剪策略。默认候选仍最多 200 个动作加 5 个控制选项；扩展模式见下节。历史片段与执行预算不变；本地超限或服务端上下文拒绝仍交给文本模型审查。

公共 `PROOFRUN_AGENT_CONTEXT_CHARS` 仍先裁剪输入，默认 64000 字符。若需要更大的整体输入，可在确认文本审查模型容量后将它设为 128000（最高 256000）；此值同时影响纯 LLM 和混合模式，不能仅凭 Jev 扩窗而直接调高。普通 LLM 继续使用共享裁剪视图；JEV 从执行器保留的原始观察独立构建有界视图，能够使用尚未进入 LLM 文本视图的候选，但无法补回 Browser Node 已省略或尚未加载的内容。

## Jev 图片、扩展候选与 Box

三个开关默认关闭，可以独立比较改造前后的效果：

```sh
# 向 JEV 发送当前截图；无需同时开启 PROOFRUN_MODEL_VISION。
export PROOFRUN_JEV_IMAGES=true
# 分组候选及更多受限动作；也可独立用于纯文本 JEV。
export PROOFRUN_JEV_EXPANDED_ACTIONS=true
# 单独试验视觉定位；要求图片开关、固定 jev-1.14.0 和新版节点。
export PROOFRUN_JEV_BOX=false
```

图片使用 [TypeSafe Images](https://docs.typesafe.ai/images) 的 `assets` 协议和 `TypeSafe-Danger-Zone-Images: true`。每次只引用一张当前截图；`sharp` 完整解码后等比缩至最长边 1568，短边不足 280 时在右下补白，不裁剪内容。原始截图证据保持不变；调用记录保留原图/派生图摘要、尺寸和证据 ID，剔除 base64，实际发送正文另记 SHA-256。生产镜像在 Linux 内安装依赖；直接挂载 macOS 的 node_modules 不能代替 Linux 原生图片依赖。

图片不参与文本字符估算。每张预留 8192 token、整个请求限制 24 MiB，均是本地保护，不代表官方精确图片 token 公式；实际用量来自供应商。带图请求遭遇 HTTP 400/413 参数拒绝时，本 tab 后续选择降级到文本并记录原因；上下文拒绝交给文本审查，认证失败保持失败。所有已派发的选择、定位、填写和审查调用都计入原预算。

扩展候选最多保留 2000 个动作，然后按总上下文预算继续裁剪；按操作分组，每组最多 254 个动作加 NONE，根问题选择具体动作组或控制选项。所有问题独立求解，只使用被选中的组答案；不跨组比较局部概率。原生 select 的各选项仍映射为明确的 target/value。新增 check/uncheck、左右容器滚动、frame、hover，均依赖节点声明及当前状态；旧节点没有 hover 声明时不提供。任意按键、URL 和标签页生命周期仍由文本模型规划，不从截图猜测参数。

Box 仅在固定 `jev-1.14.0` 且当前节点声明画面复核能力时提供 VISUAL_LOCATE 候选。选中后额外请求存在性、唯一性和边框；三个判断共享当前截图，所有门槛通过后才生成动作。存在概率、唯一目标概率/置信度和 Box 置信度使用本地实验门槛 0.9，尚未由真实站点校准，不能解释为 90% 正确率。框落入补白区、原图与视口比例异常、目标不唯一或坐标非法时交回文本审查。

坐标以原始视口 CSS 单位派发。可唯一关联到主视口 DOM 控件时恢复 DOM 点击及重访检查；其他位置使用现有 visual.click。新版节点在输入前重新截图并要求完整 PNG 摘要一致，再核对视口及有效期；弹层、动画、光标闪烁或其他画面变化可能导致拒绝并重新观察。这是保守复核，不能证明截图与输入原子同步，也不能检测外观完全相同但语义改变的控件。持续动态页面应使用 DOM 或文本恢复路径。

代码分别位于 `model/jev-image.ts`（图片与来源）、`model/jev-questions.ts`（分组协议）、`model/jev-box.ts`（定位校验），提示词仍集中在 `prompts/jev.ts`。执行器持有原始观察，适配器只裁剪自己的请求副本。业务验收与工作流推进仍经过公共执行器和文本审查，选择 VERIFY 或得到高置信度 Box 都不等于验收通过。

## 提示词与上下文边界

`src/prompts/decision.ts` 独立维护执行系统提示，`src/prompts/jev.ts` 维护候选选择、字段填写与文本审查提示；适配器只负责组装请求与解析协议。

`src/execution/context.ts` 负责历史正文去除旧元素编号、上下文预算裁剪和覆盖标记。`runner.ts` 负责租约安全点、当前步骤与执行状态，传入事实快照；裁剪不能修改原始观察、任务或报告证据。

## 身份选择

主循环先领取身份选择工作，再领取浏览器任务。身份选择 Agent 使用独立提示词 `src/prompts/identity-selector.ts`，单次工具调用根据 Case 与同源候选摘要选取账号；模型不接触 Cookie、profile 或内部凭据文件。选取失败或没有适用账号转人工。选取和状态加载不证明账号角色有效，执行器仍检查页面条件。新版身份库不自动保存认证状态，只有 HITL 成功后由控制面发布完整 profile 基准。详见[测试身份](../api/src/modules/identities/README.md)。

## 通用子目标与执行进度

`PROOFRUN_AGENT_EXECUTION_GUIDANCE=true` 为本 worker 启用 `evidence-settlement-v2`，同时作用于 `llm` 和 `jev`。默认关闭，先在独立本地/灰度 worker 验证；运行中的执行不热切策略。模型和任务预算保持原配置。

- 文本动作和阻塞工具可携带 `conclusions`，复用原验收账本，先校验并保存动作前已有证据支持的结论，再执行新动作。保存失败不派发动作；后续动作失败保留独立结果。完整回复中的动作参数无效时，只保存通过独立校验的结论；截断回复仍整体拒绝，不猜测缺失内容。finish 的工作流元数据错误不抹掉合法独立结论。结构化任务同时写入步骤快照，旧非结构化任务保留在最终报告中。
- 提示词与工具声明统一使用顶层 `conclusions`；解析层也接受明确的 `workflow.conclusions` 同名字段并执行相同校验，同时声明两份则拒绝，其他未知字段不放宽。
- 原预算尾部进入一次只读整理阶段：根据近期文本请求耗时预留模型和保存时间，仅剩一次模型额度时直接整理。探索请求截止点不侵占预留；整理工具撤下浏览器操作，不增加总时长、模型次数或动作额度。估算不能保证供应商及时回复，失败仍保留真实未完成状态。完成工具的裸工作流数组只无损补为 assessments 容器，条目仍校验原步骤与附件；其他协议错误复用既有三次连续错误上限，在剩余时间和模型额度内纠正，始终不重新开放浏览器动作。
- 阅读或验收记账、定位线索与普通低预算提示不再单独触发 JEV→文本复核；保留新增答案需登记、填写结果、计划耗尽、停滞和实际故障的复核。启用新策略时移除每四个动作一次的重复验收提示。
- 文本上下文只合并 URL、标题、全文和截断状态完全相同的历史副本，保留所有来源附件与观察身份；不把历史正文变成差分节选；不裁掉原标准、约束或覆盖缺口。只读收尾使用专用简短提示词。
- 动作工具通过 `workflow.recovery` 附带持续子目标，可与第一步动作在同一次调用提交。`criterionIds` 引用原标准，`phase` 为 locate/interact/collect/review，`allowedActions` 只收窄动作。成功条件由后续真实观察复核，不直接产生验收通过。
- 公共执行层生成 `executionGuidance`：原始未完成标准、当前计划、循环事件、历史位置线索和不确定预算估算。JEV 根据当前子目标排序候选，遇到事件交回 LLM；正常动作不逐个追加 LLM 审批。
- 同一真实页面状态、标准范围与阶段的局部额度不会因改写目标或人工交接重置；真实页面状态变化后可为不同子目标分配有界尝试；权威步骤、阅读或独立验收记录新增后可重新尝试旧策略。任务/步骤硬预算始终累计。不能借重规划重放结果未知的操作。
- 位置记忆只包含观察过的名称、区域和位置；不包含旧 target、字段值和可执行选择器。换页或控制代次变化后失效；iframe 和嵌套容器不猜测主文档坐标。
- 支持幅度的新节点在观察 `viewport.scrollDistance=true` 声明能力。执行器按当前视口/容器的 75% 计算 100..1200 CSS 像素滚动，旧节点继续使用方向及 400 像素。模型只选择方向，不能注入任意距离。
- 控制台决策调用详情展示策略版本、计划身份、复核原因和成本估算；完整事件、证据和实际请求仍按现有归档机制保存。

回退：停止给灰度 worker 分配新任务，等待当前任务及清理结束，再关闭开关并重启。证据、已执行动作、预算和旧报告不修改。浏览器新节点兼容旧方向命令，可以单独回滚 Agent 策略。

验证分为合成状态/协议回归、真实 Chromium 本地夹具和外部业务回归，结果不可混称。`tests/agent/execution-guidance.test.mjs` 覆盖循环、预算、失效与模式交接；`tests/agent/guidance-browser-fixture.py` 提供长页表单、嵌套列表和分阶段配置三个真实页面。外部网站应固定模型、图片开关和预算，另外保留未参与调优的任务作为验证集；本地夹具通过不能证明跨网站成功率。
