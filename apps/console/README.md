# proofrun-console

React + Vite 控制台。已接入真实控制面 API：任务列表、搜索与状态筛选、游标分页、任务提交与取消、任务详情、验收报告、DOM/PNG/NETWORK 证据预览、报告 JSON 导出、节点注册/撤销/轮换、人工介入与操作记录。

沿用 [x.ai 视觉规范](../../docs/console-design.md)，深浅主题共用 `src/tokens.css`。当前使用本机字体替代原站自定义字体；主题切换在当前页面生效。没有 Spec 分析、验收标准生成或执行 Agent 的第二份状态机。

## 本机运行

先按 [API 说明](../api/README.md) 启动 PostgreSQL 与 API，再运行：

```sh
pnpm --filter @proofrun/contracts build
pnpm dev:console
```

打开终端给出的地址，在页面输入 API 的 `PROOFRUN_ADMIN_TOKEN`。连接验证成功后，凭据保存在当前站点的浏览器 localStorage，刷新、重新打开或断开连接后会自动填入，仍需点击连接。连接页可通过「清除已保存凭据」移除本地记录；验证失败不会覆盖原记录。本地存储受限时仍可连接，并提示保存失败。凭据不进入 URL、构建包或 Vite 环境变量。

开发服务器默认将 `/v1` 和 `/health` 代理到 `http://127.0.0.1:4100`。API 端口不同时，在启动前设置服务端环境变量 `PROOFRUN_API_PROXY`。改动配置后重启 Vite。不要在代理层注入固定管理员凭据，也不要使用 `VITE_*` 配置密钥。

生产构建使用 `pnpm --filter @proofrun/console build`。发布 `dist` 后，部署入口需要将 `/v1` 转发到同源 API；远端访问使用 HTTPS。Vite 开发代理不属于生产构建，单独运行静态预览不能代替 API 代理。当前没有 SSO、多租户或面向公网用户的会话管理。

## 模块边界

| 文件                        | 职责                                             |
| --------------------------- | ------------------------------------------------ |
| `src/main.tsx`              | 连接、页内路由、全局导航                         |
| `src/api.ts`                | 同源请求、超时与错误；证据限额和摘要核对         |
| `src/use-resource.ts`       | 当前页面轮询、取消旧请求、成功数据与读取错误分离 |
| `src/pages/task-list.tsx`   | 任务和报告索引；筛选变化重置游标                 |
| `src/pages/task-submit.tsx` | 提交上层已定义 JSON，不生成标准                  |
| `src/pages/task-detail.tsx` | 任务事实、独立清理状态、逐项结论和证据入口       |
| `src/pages/nodes.tsx`       | 节点连接、能力、占用、配对和撤销                 |
| `src/components`            | 共享状态/布局、证据预览、报告导出                |

页面只在可见时每 5 秒继续轮询，前一次结束后才调度下一次。翻到后续列表页时暂停自动刷新，返回第一页恢复。页面切换和断开连接会中止读取，迟到结果不覆盖新任务。失败时保留上次成功数据并明确提示错误和读取时间。

任务提交与取消不自动重试。请求未确认时保留输入，先查询任务 ID；同 ID 同定义才可幂等重提。取消只撤销后续执行，不能回滚已发生的业务写入。浏览器关闭确认单独展示。

证据通过同源 ID 读取，不跟随报告中的 URI。校验大小、类型与 SHA-256 后展示，DOM 以纯文本处理。证据选择变化时取消旧读取并释放对象 URL。报告导出先提供完整 JSON 预览，再提供复制和下载入口。

## 验证

```sh
pnpm test:console
pnpm --filter @proofrun/console build
# 使用独立 PostgreSQL，自动创建并回收临时数据库。
PROOFRUN_TEST_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/proofrun pnpm test:api
```

浏览器联调夹具：确保 4100 端口空闲，设置测试数据库变量后运行 `pnpm exec tsx tests/console/serve-fixture.mjs`。页面使用该文件 `ADMIN` 常量中的临时访问凭据。脚本会准备排队、验收通过、受阻、执行错误及 DOM/PNG 证据；按 Ctrl+C 回收独立数据库和临时证据目录。所有任务标题明确标记“联调夹具”，节点是协议模拟，截图为最小 PNG，不代表真实模型或浏览器业务验收。

本批覆盖与未覆盖项见 [Console 验证记录](../../docs/console-validation.md)。本轮已补节点配对/撤销/轮换、人工介入、登录状态保存与操作追踪，详见 [迁移交付](../../docs/migration-completion.md)。当前仍为管理员操作台，没有用户体系。

独立免登录 HITL 处理页、实时浏览器画面、受限输入和完成交接现已接入，使用与验证边界见 [HITL 说明](../../docs/hitl.md)。

## 创建时选择执行模式

表单顶部支持「并行对比」「纯 LLM」「LLM + JEV」，新建表单默认并行对比。选择写入任务定义的 `executionMode`，切换 JSON 编辑和重跑时保留。导入未带此字段的旧 JSON 仍按纯 LLM 运行，不自动扩展为两组。

并行模式一次创建两个独立任务，每组使用完整预算；是否同时运行受节点容量限制。启用共享登录状态时只能选择单组模式。并行任务 ID 最长 100 字符；接口返回首组任务详情，控制台跳转到两组对照页面。
