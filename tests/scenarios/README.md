# 端到端业务测评

这套工具验证 Agent 的业务结论是否正确，并保留任务、服务端事实、证据和资源关闭回执。已知缺陷 E08 的正确结果是报告 `FAILED`、测评通过；任务 `COMPLETED` 或显示成功提示本身不构成通过。

## 组成与边界

- `cases/catalog.mjs`：12 个版本化 Case v2 场景，`smoke` 选 E01/E08/E12，`core` 运行全部，也可指定单个编号。
- `fixture/`：可操作的 HTTP 业务页面与持久化业务记录。初始化和真值查询仅走私有 Unix socket；浏览器无法访问该管理入口。
- `oracles/evaluate.mjs`：用服务端查询事实与报告逐项比较，核对引用 DOM 正文、必需媒介、文件摘要、重复写入和会话关闭。截图只验证格式、摘要与引用，不自动裁决图片语义。
- `harness/`：固定顺序种子、预算预留、原子保存、恢复对账、HITL 脚本、材料导出和离线比较。
- `linux_evaluation.py`：独立 PostgreSQL/API/Agent/Rust Node/systemd/Chromium 环境。默认模型为脚本，显式配置后使用真实模型。

| 编号 | 验证内容       | 独立事实                               |
| ---- | -------------- | -------------------------------------- |
| E01  | 普通表单       | 保存值与查询记录                       |
| E02  | 输入校验与修正 | 无效值校验事件、正确邮箱查询           |
| E03  | 同名选项       | 最终选项 ID 为 west                    |
| E04  | 虚拟列表       | 第 40 项 city-40 的查询结果            |
| E05  | 多面板阅读     | 两面板各自展开、正文证据               |
| E06  | 分阶段配置     | 名称及通知开关持久化                   |
| E07  | 异步提交       | 延时完成后查询；提交一次               |
| E08  | 虚假成功提示   | 后端没有记录，正确报告 FAILED          |
| E09  | 访客身份       | 未登录且没有写入                       |
| E10  | 人工交接       | 真实 HITL 协议、验证码登录后继续查询   |
| E11  | 多分组         | 甲乙组分别查询自己的记录               |
| E12  | 清理           | 保留删除前业务事实，独立核对删除后查询 |

E10 由固定坐标脚本扮演人工处理者，不覆盖 Console UI、真实人工体验或 SSO。E11 核对业务分组数据，不证明跨站点身份隔离。受控站点结果不代表生产网站泛化。`basic-form/task.json` 仍是历史协议样例，不参与本测评。

## 本地与 CI 冒烟

```sh
pnpm test:e2e:harness
# 根据 Docker 架构选 x64 或 arm64；下载器校验固定版本摘要。
node scripts/download-test-engine.mjs x64 .proofrun/bin/agent-browser-linux-x64
PROOFRUN_TEST_AGENT_BROWSER="$PWD/.proofrun/bin/agent-browser-linux-x64" \
PROOFRUN_EVAL_OUTPUT=/tmp/proofrun-evaluation-new \
pnpm test:e2e:linux
```

结果目录必须尚不存在，父目录必须存在。默认串行执行三条脚本模型场景，并在首次任务提交后杀死测评进程、从原清单恢复，核实原任务身份没有变化；真实浏览器写入仅限回环测试应用。脚本退出时复制测评材料并删除独占容器与网络；不会连接现有开发或业务数据库。CI 在每次 push/PR 执行工具自测与 Linux 脚本冒烟，并保存材料七天。

脚本模型只支持 `smoke`、`E01`、`E08`、`E12`，不能据此计算真实模型质量或费用。Docker 需要支持一次性 systemd/cgroup 测试容器的 privileged 模式；它不是生产配置。

## 真实模型测评

显式导出 `PROOFRUN_MODEL_BASE_URL`、`PROOFRUN_MODEL_API_KEY`、`PROOFRUN_MODEL` 及需要的模型选项，再运行：

```sh
PROOFRUN_TEST_AGENT_BROWSER="$PWD/.proofrun/bin/agent-browser-linux-x64" \
PROOFRUN_EVAL_OUTPUT=/tmp/proofrun-evaluation-real-new \
PROOFRUN_EVAL_MODEL_KIND=real PROOFRUN_EVAL_MODE=llm \
PROOFRUN_EVAL_SUITE=core PROOFRUN_EVAL_REPEAT=1 \
PROOFRUN_EVAL_MAX_CALLS=1000 PROOFRUN_EVAL_SAMPLE_MS=300000 \
pnpm test:e2e:linux
```

工具不隐式加载 `.proofrun/local.env`。容器只继承模型配置白名单；服务地址必须从容器可达。`PROOFRUN_EVAL_MODE=jev` 另外需要 `TYPESAFE_API_KEY`，可选 `TYPESAFE_MODEL` 及产品现有 JEV 开关。每份结果记录真实/脚本模式、模型、执行策略、配置摘要、源码身份及节点运行时。源码身份不等于声明的远端部署版本。

JEV 网络排查应在同一容器运行时对比默认出口与代理，不能用宿主机连通性代替容器结果。需要代理时显式设置 `PROOFRUN_EVAL_HTTPS_PROXY`（例如 Docker Desktop 可访问的 `http://host.docker.internal:8234`），驱动为 Agent 启用 Node 24 的环境代理，并让本地控制面、夹具及主模型域名走原路径。不会自动继承宿主机系统代理。结果记录 `jevNetwork`，配置摘要包含代理配置的哈希，不导出代理凭据。变更网络路径的批次应单独标注，不归因于模型或提示词改进。

请求诊断区分 `TRANSPORT_CONNECT_TIMEOUT`（建立连接超时）、`TRANSPORT_REQUEST_TIMEOUT`（配置的整体期限）、`TRANSPORT_RESPONSE_TIMEOUT`（运行时响应等待期限）、`TRANSPORT_DNS_ERROR` 与 `TRANSPORT_CONNECTION_RESET`；其他连接故障保留 `TRANSPORT_ERROR`。这些分类不包含原始异常或凭据，仍遵循原有回退和调用额度。连接超时能定位到连接阶段，不能单凭该码区分本地链路、代理出口或远端网络故障；历史通用错误码也不能事后认定成因。

调用额度按产品冻结的逐步最大调用数预留，失败也消耗预留额度；不会为改善分数追加重试。用量只统计归档的浏览器执行模型请求，缺失 usage 保持未知，不推算供应商账单。首次评估建议每场景一次；稳定性比较时固定种子、重复次数和预算，至少重复三次，并展示原始分母。

## 长期隔离环境与恢复

一次性 Docker 环境退出后只保留导出结果，不能恢复已经删除的数据库。需要中断恢复时，使用自己管理的**专用测评环境**，保持 API、Agent、节点及 fixture 状态：

```sh
PROOFRUN_EVAL_FIXTURE_DIRECTORY=/private/eval-fixture \
PROOFRUN_EVAL_FIXTURE_SOCKET=/private/eval-fixture.sock \
node tests/scenarios/fixture/server.mjs
# 将其输出端口配置为 PROOFRUN_EVAL_FIXTURE_URL。
export PROOFRUN_CONTROL_URL=http://127.0.0.1:4121
export PROOFRUN_ADMIN_TOKEN=your-isolated-admin-token
export PROOFRUN_EVAL_FIXTURE_URL=http://127.0.0.1:4321
export PROOFRUN_EVAL_FIXTURE_SOCKET=/private/eval-fixture.sock
pnpm eval:e2e --output /private/eval-run --environment /private/environment.json --suite core
pnpm eval:e2e --output /private/eval-run --environment /private/environment.json --resume
```

`environment.json` 至少包含 `{"mode":"llm","modelKind":"real","model":"your-model"}`，可选 `jevModel`、`executionPolicy`、`vision`、`agentCommit`、`apiCommit`、`configSha256`；不得放入密钥。该声明由调用者负责与实际部署一致；Linux 入口自动从自己启动的配置生成。API 的 Case profile 必须匹配单一执行模式、允许必要的人工介入、包含 DOM/SCREENSHOT，并使用专属节点池。

恢复先查原请求 ID，不生成新任务。取消请求丢回执时查询原任务再幂等重送取消；不会重放业务操作。场景版本、环境、页面 origin 变化将拒绝恢复。输出目录有排他锁；强制杀进程后，先确认原进程确已退出，再删除该目录的 `runner.lock`。清单保留中断时间，崩溃间隔保守计入总时间额度。

## 输出、判定和比较

`run/manifest.json` 固定样本全集、种子、版本、配置和额度；每个样本有 `sample.json`、`task.json`、`facts.json`、`calls.json`、`evidence.json` 与证据二进制。`summary.json` 保留计划、启动、完成、通过、未运行及不完整样本。Linux 额外的 `runtime-check.json` 只在实际用户服务已关闭后生成，脚本冒烟的 `recovery-check.json` 记录进程中断前后的同一任务身份。`routing.json` 在测量结束后采集模型路由原因，不保存完整模型正文，也不计入样本耗时；配置为 JEV 不代表每一步实际调用了 JEV，应结合 `calls.json` 核对供应商请求。

人工脚本失败保留具体错误码，取消本样本并收集已有事实；确认会话关闭后才继续其他样本。失败不会自动重放输入或改为通过。此类错误属于测评工具/交接链路异常，不能直接归因为模型业务判断错误。

`activity.json` 保存测量结束后的命令类型、状态和错误码，`routing.json` 同时保留模型决策的动作/等待条件摘要，不保存填写值。脚本模式单独运行 `E07` 会故意等待不存在的文本，验证真实节点在命令截止前返回、Agent 重观察后查询记录且不重复保存；`wait-recovery-check.json` 记录恢复耗时。它只验收恢复链路，不计入真实模型通过率。真实模型稳定性测评可用 `--repeat 3`（Linux 为 `PROOFRUN_EVAL_REPEAT=3`），同一场景每次使用独立样本，全部重复按固定种子排序；应保留逐轮结果和失败，不挑选最好的一轮。

`--max-calls`（Linux 为 `PROOFRUN_EVAL_MAX_CALLS`）按每例的最坏请求额度预留，已完成样本不会释放预留量；它不是只累加已发生的 HTTP 请求。运行完整批次前应按 `callAllowance(definition(...), mode)` 累加所有场景并乘以重复次数。当前 `core` 三轮需要为纯 LLM 预留 1200、JEV+LLM 预留 2400 次；实际请求数仍以 `calls.json` 为准。额度不足导致的未启动样本必须保留，不能当作完整批次比较。

JEV 图片模式启动前会检查原生图片依赖。跨平台挂载工作目录时，测试镜像通过 `NODE_PATH` 提供与 Agent 同版本的 Linux `sharp` 依赖；修改版本后需重新构建镜像。缺失依赖应在请求模型前失败，不能将图片预处理失败后的纯 LLM 回退当作 JEV 实际效果。

分类包括正确结论、错误通过、错误失败、无事实支持、未观察、结论不完整、证据不足、重复验收项。事实未知不能当作产品失败，缺失关闭事实不能当作关闭成功；业务判定和清理判定分别记录。

```sh
pnpm eval:e2e:compare /private/baseline/run /private/candidate/run
```

比较拒绝不同场景/判定版本、种子、重复次数、样本缺口及脚本/真实模型混用。预算差异逐样本展示，不宣称等预算提升。退出码：0 全部通过/无回退；1 有测评失败/质量回退；2 有未完成样本。配置或材料损坏会直接报错，不生成通过结论。

## 故障和 UI 验证仍分层执行

真实 Linux 故障入口仍为 `PROOFRUN_TEST_FULL_LINUX=true pnpm test:agent:linux`：验证节点重连、控制面重启、命令去重、租约/取消及资源回收；其中部分浏览器采用故障引擎。它们与业务测评使用不同分母，不合并为“真实模型成功率”。

当前尚不包含真实 CDP 写入完成后丢失响应的全链路注入，也不包含 Console 新建、进度、证据下载与人工交接的完整浏览器验收。现有协议/组件测试不能替代这些边界的后续验收。
