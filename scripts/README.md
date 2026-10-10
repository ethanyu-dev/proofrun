# 工程与模型回放工具

所有命令从仓库根目录执行。工具只处理明确提供的任务和证据；原始请求、响应与临时结果写入 Git 忽略的 `.proofrun/`，不在文档中维护实验运行记录。

| 工具                                      | 用途                                                          |
| ----------------------------------------- | ------------------------------------------------------------- |
| `generate-contracts.mjs`                  | 从 JSON Schema 生成类型，`--check` 检查漂移                   |
| `dev-local.mjs`                           | 在 Mac 启动 API、Agent、Console，复用既有 Docker 数据库和节点 |
| `dev-api-relay.mjs` / `dev-node-relay.py` | 本机 API 与 Docker 节点之间的证书校验 TLS 转发                |
| `generate-public-api.mjs`                 | 生成公开 OpenAPI，与契约生成流程配套                          |
| `download-test-engine.mjs`                | 下载固定原生引擎并核对摘要                                    |
| `accept-task.mjs`                         | 提交既定任务、等待执行与关闭、导出报告和摘要匹配证据          |
| `audit-acceptance.mjs`                    | 离线审计已有导出的一致性、证据摘要、验收引用和用量            |
| `test-jev.mjs`                            | 历史观察的 JEV 建议测试，支持仅准备输入                       |
| `compare-jev.mjs`                         | 相同历史输入下交替请求 JEV 与文本模型                         |
| `replay-agent-baseline.mjs`               | 使用原 Agent 提示与工具协议重放历史观察                       |

## 验收材料审计

```sh
# 首次使用先构建共享协议；审计只读本地材料，不调用模型或提交任务。
pnpm --filter @proofrun/contracts build
pnpm audit:acceptance .proofrun/acceptance/<taskId>
# 显式纳入全部历史目录，保留失败和缺失样本；纯 JSON 可供后续处理。
pnpm --silent audit:acceptance .proofrun/acceptance/* > .proofrun/acceptance-audit.json
```

每份目录使用 `accept-task.mjs` 的 `task.json`、`report.json` 和证据文件格式。审计验证当前 Schema、任务身份、报告副本一致性、终态与报告生命周期及执行分类的对应关系、关闭确认、验收项完整性、整体结论与逐项结论的一致性、证据引用、必需媒介和 SHA-256；拒绝重复验收项定义、证据文件路径穿越及符号链接。每份结果保存源文件摘要，缺失和损坏的样本不会被静默忽略，重复任务标记为 `DUPLICATE_SAMPLE`。

退出码 0 只代表全部材料通过完整性检查，执行失败的任务也可以拥有完整材料；1 表示至少一份材料缺失、不一致或尚未关闭；2 表示没有提供目录。`reportedVerdict` 保留模型结论，`businessReview` 始终为 `NOT_REVIEWED`。本工具不验证业务真值、页面内容真实性、部署版本或模型配置，不核对结构化步骤和关联清理任务的完整材料，不计算业务成功率。

耗时与调用数来自报告。token 为已记录用量，缺失时返回 null，不补成零；用量完整性与费用保持未知。历史样本可能使用不同任务、预算和版本，不自动合并为 JEV/LLM 胜率或当前版本基线。真实任务验收仍需按[部署说明](../deploy/README.md#业务验收)绑定版本、配置及独立业务复核。

## JEV 回放与对比

```sh
# 六个页面状态，各重复三轮；产生真实供应商请求，不执行浏览器动作。
pnpm test:jev:compare
# 使用 Agent 协议重放三个表单状态，同样会产生真实模型请求。
pnpm test:jev:agent-baseline
```

对比器使用本机既有表单和价格页面的历史任务证据；输入缺失时应先准备对应证据，不能把缺失输入当作模型失败。模型与网络会变化，重跑数值不保证相同；建议选择准确性不等于实际任务成功率。实时双会话使用 [并行对比](../docs/parallel-comparison.md)。

## 配置与运行

将 TypeSafe 密钥配置到被 Git 忽略的 `.proofrun/local.env`：

```dotenv
TYPESAFE_API_KEY=你的真实密钥
TYPESAFE_MODEL=jev-latest
```

使用 `pnpm dev:local` 时，若 JEV 需要本机 HTTP 代理，可在同一文件中追加以下配置（端口按本机代理修改）。启动脚本将这些设置传给 Agent；Node 24 的 `fetch` 需要 `NODE_USE_ENV_PROXY=1` 才会使用代理。`NO_PROXY` 中列出控制面及需要直连的文本模型域名，Docker 中的浏览器代理由节点单独配置。修改后需重启 Agent 才能生效。

```dotenv
NODE_USE_ENV_PROXY=1
HTTP_PROXY=http://127.0.0.1:8234
HTTPS_PROXY=http://127.0.0.1:8234
NO_PROXY=localhost,127.0.0.1,::1,apiproxy.paigod.work
```

配置方法参考 [TypeSafe Quick Start](https://docs.typesafe.ai/introduction/quickstart.md)。该密钥用于 TypeSafe 模型服务；Console 访问凭据和现有其他模型的密钥不能直接替代它。

```bash
# 从仓库根目录执行；真实请求最多三次，失败即停止，不自动重试。
pnpm test:jev

# 只检查证据并生成请求文件，不调用模型。
pnpm test:jev --prepare
```

环境文件位于其他位置时：

```bash
node --env-file=/absolute/path/to/jev.env scripts/test-jev.mjs
```

默认输入为 `.proofrun/acceptance/novita-glm-pricing-bfb1f1c8`。可以通过 `PROOFRUN_JEV_SOURCE_DIR` 指向同格式的证据目录；必须包含搜索框和 Dedicated Endpoints 选中状态的页面快照。

## 测试边界

| 测试             | 检查内容                                   | 不覆盖的范围                         |
| ---------------- | ------------------------------------------ | ------------------------------------ |
| 搜索框选择       | 给定明确子目标，是否选择填写 Search models | 填写值生成、搜索结果、价格准确性     |
| 切换栏目         | 是否建议点击 SERVERLESS ENDPOINTS          | 实际点击、导航、页面加载             |
| 完整目标的下一步 | 原始 GLM 任务下的动作建议和完成倾向        | 没有唯一动作标签，不据此判定业务成功 |

输入属于真实网站的历史观察；JEV 服务调用是真实调用。测试程序不会执行浏览器操作，不会让当前 LLM 消费建议，也不属于完整的 ProofRun 实时闭环。元素能力仅按历史角色构造为建议候选，可执行性尚未验证。页面文字限制为 6,000 字符并明确标记截断。

每次输出到 `.proofrun/jev-tests/<时间-唯一标识>/`：

- `*.request.json`：发给模型的实际请求，不含 Authorization。
- `result.json`：输入证据摘要、实际模型、延迟、用量、选择概率、置信度、目标和预期匹配结果。

`MATCHED_EXPECTATION` 仅表示定向建议匹配，`EXPLORATORY_ONLY` 仅表示探索性调用完成。HTTP 错误、非法响应或网络错误会单独记录；不将服务失败计作建议错误。完整任务是否通过，需要后续接入执行循环并核验实际证据。
