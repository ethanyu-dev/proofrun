# 执行循环

`profile-runner.ts` 编排 profile 分组与共享环境，`runner.ts` 执行当前步骤、模型决定与浏览器操作。`context.ts` 白名单投影和裁剪唯一模型视图；`lease.ts` 独立维持租约，模型调用不能延长执行权限。详细职责、字段和删除清单见 [简化架构](../../../../docs/agent-loop-simplification-design.md)。

每轮从 task、state、page、history、evidence、budget、feedback 构建请求，调用一次 LLM。工具与 prompt 读取同一个最终上下文。模型只通过 progress 提交原始要求声明、验收结论和阅读进度，程序先校验并保存，再执行至多一个决定。操作后自动刷新观察，协议错误使用下一轮原额度纠正。

任务 URL 默认表示访问入口；最终地址、重定向与语言持久性只有原任务明确要求时才参与验收。语言核对使用当前主文档的 lang 和实际正文，不能仅凭 URL 前缀否定已观察事实。历史片段同时保留正文与文档语言声明，不同语言声明的快照不能合并，也不能替代当前状态。

`workflow.ts` 只保留原始要求完成账本，没有局部 plan 或恢复计划。`criteria.ts` 保留独立验收结果；确定判定不可改写，暂存结论升级仍需要新增有效证据。`interaction-progress.ts` 保留面板原文与阅读身份；`operation-journal.ts` 保留近期及关键命令回执。成功回执只证明操作发生，不证明业务成功；未知副作用停止，不换命令 ID 重放写入。

setup 的 PREPARING 声明结束后，CHECKING 使用新观察独立核验身份和原始 policy。共享环境门禁通过后才运行依赖步骤；人工确认不代替业务验收。身份变化使旧观察、确认及在途决定失效，已发生的业务操作事实保留。人工交还保留当前页面，同入口步骤不无故重新导航；新分组页仍需首次导航。

`keyboard-receipt.ts` 区分请求焦点与节点确认。定向 press 必须使用当前目标并且节点支持 targetedPress；focusVerified 只证明派发前焦点，不证明失焦校验或业务结果。原生条件等待仅对明确 FAILED/NOT_STARTED 的未命中进行有界观察恢复，传输超时与未知效果仍停止。

scroll 意图只接受 up/down/left/right；不接受方向附带像素数或 top/bottom。工具 schema 与执行器使用相同方向集合，非法值会明确提示格式。节点支持幅度时，执行器按页面或容器可视范围计算距离并限制上限；历史命令回执保留实际派发的像素数，但不能直接用作模型参数。

每个模型请求经 `model/request.ts` 记录实际 prompt、tools、最终 context 和用量。图片原文以证据引用替代，保存原始请求摘要；请求存档失败则不派发。没有 JEV 候选请求、填写值子调用、legacy/guidance/planned-v1 路由或二次 context 投影。

身份准备每会话只尝试一次，并由 profile 分组共享同一真实命令回执。案例使用临时浏览器，不保存基准或通过保存重启浏览器；账号和节点占用仍待物理关闭确认后释放。运行与升级配置见 [Agent README](../../README.md)，公开步骤和预算见 [v2 协议](../../../../docs/public-api-v2.md)。
