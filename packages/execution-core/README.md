# 共享执行规则

供内置 Agent 和 API 运行时共同使用，依赖仅限协议包及标准库。`execution/` 保留原模块名，包含要求与结论账本、身份/policy 门禁、上下文投影、观察与动作关联校验、逐步预算和收尾规则；`evidence/` 负责证据视图与有限网络读取；`report.ts` 统一产品判定与 profile 汇总。

`ports.ts`、`model.ts` 定义执行器需要的端口。这里不连接数据库、HTTP、MCP 或模型供应商，也不开启后台定时器。带等待、观察、状态转换、命令派发及 profile 并发的编排在 `@proofrun/execution-driver`；纯规则不自行驱动浏览器。

构建运行 `pnpm build:execution`。`tests/agent` 的证据回归直接引用本包构建产物，其余规则仍通过 Agent 兼容导出验证，`tests/agent/runtime-integration.test.mjs` 比较新旧适配路径。模拟模型和节点的测试不代表真实浏览器验收。

## 执行证据

`evidence/observation.ts` 检查节点观察结构，并与控制面可用清单核实归属、种类和摘要。报告只引用本次执行中已经可用的证据，API 再次独立校验。DOM 与截图不是原子快照；结构和摘要正确不等于模型对页面业务的解释正确。
