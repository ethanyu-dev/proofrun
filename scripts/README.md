# 工程与模型回放工具

所有命令从仓库根目录执行。工具只处理明确提供的任务和证据；原始请求、响应与临时结果写入 Git 忽略的 `.proofrun/`，不在文档中维护实验运行记录。

| 工具                                      | 用途                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `generate-contracts.mjs`                  | 从 JSON Schema 生成类型，`--check` 检查漂移                                                        |
| `dev-local.mjs`                           | 在 Mac 启动 API、Agent、Console，连接配置的 PostgreSQL；`--with-preview-node` 可恢复旧 Docker 节点 |
| `dev-api-relay.mjs` / `dev-node-relay.py` | 本机 API 与 Docker 节点之间的证书校验 TLS 转发                                                     |
| `generate-public-api.mjs`                 | 生成公开 OpenAPI，与契约生成流程配套                                                               |
| `download-test-engine.mjs`                | 下载固定原生引擎并核对摘要                                                                         |
| `accept-task.mjs`                         | 提交既定任务、等待执行与关闭、导出报告和摘要匹配证据                                               |
| `audit-acceptance.mjs`                    | 离线审计已有导出的一致性、证据摘要、验收引用和用量                                                 |

## 验收材料审计

主动业务测评使用 `evaluate-e2e.mjs`，版本对比使用 `compare-e2e.mjs`。隔离环境、模型配置、预算、恢复与 12 个业务场景见 [端到端测评说明](../tests/scenarios/README.md)。它与下述已有任务的材料审计使用不同判定范围。

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

## 本地配置

模型配置放在被 Git 忽略的 `.proofrun/local.env`。使用 `PROOFRUN_MODEL_BASE_URL`、`PROOFRUN_MODEL_API_KEY` 和 `PROOFRUN_MODEL`；视觉按模型能力设置 `PROOFRUN_MODEL_VISION`。新执行只有 llm，JEV、旧执行策略与相应回放脚本已退役。

`pnpm dev:local` 启动 API、Agent 和 Console；API 使用该环境文件配置的数据库。启用 Docker 预览节点时，启动器写入开发覆盖项，使用当前 Cargo 构建与本地配置。需要 HTTP 代理时设置 `NODE_USE_ENV_PROXY=1`、`HTTP_PROXY`、`HTTPS_PROXY` 和适当的 `NO_PROXY`，修改后重启 Agent。

`pnpm test:agent:browser` 使用真实 Rust session-host/Chrome 和本地 HTTP 表单，模型回复由脚本提供，验证逐轮填写、唯一提交和结果观察。真实模型的业务测评使用 `eval:e2e`；两者不能互相替代。
