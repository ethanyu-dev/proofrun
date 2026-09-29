# 真实 JEV 建议测试

## 当前结果（2026-09-27）

已配置 TypeSafe 并完成真实请求：JEV 与当前文本模型各 18 次同输入比较，另有 3 次 JEV 初测和 9 次原 Agent 协议复测。完整结果见 [真实对比报告](jev-comparison-2026-09-27.md)。仅重放页面观察测试模型建议，没有执行浏览器动作。

```bash
# 六个页面状态，各重复三轮，交替请求 JEV 和当前文本模型。
pnpm test:jev:compare

# 使用原 Agent 系统提示与六工具协议，独立复测三个表单状态。
pnpm test:jev:agent-baseline
```

比较器需要当前本机保存的历史任务证据。模型和网络具有变动性；重跑会产生真实调用，数值不保证相同。

## 初次准备记录（2026-09-26）

- 已准备三组来自既有 Novita 真实页面 DOM 的输入，并核对原报告中的 SHA-256。
- TypeSafe 地址的未鉴权 GET 返回 HTTP 405，表明本机能收到服务响应；这不证明密钥有效或推理可用。
- ProofRun、devproof 环境文件及当前环境未发现 `TYPESAFE_API_KEY`。
- 首次执行状态为 `BLOCKED_MISSING_KEY`，真实模型请求数为 0；没有 JEV 耗时、建议准确率或任务成功率结果。

## 配置与运行

将 TypeSafe 密钥配置到被 Git 忽略的 `.proofrun/local.env`：

```dotenv
TYPESAFE_API_KEY=你的真实密钥
TYPESAFE_MODEL=jev-latest
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
