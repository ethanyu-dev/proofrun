# 共享执行驱动

承接观察、阶段推进、setup/policy 门禁、progress 先保存、动作调度、证据交付、分组并发与清理屏障。通过 `ExecutionClient` 和 `DecisionModel` 端口访问外界；具体 HTTP、数据库、节点通信、模型供应商均由宿主注入。领域规则来自 `@proofrun/execution-core`。

版本 0 在 Agent 进程使用 HTTP ControlClient 和 ChatModel。版本 1 在 API 进程使用 RuntimeDriver 和决定队列，Agent 只负责模型调用及续租。两条路径执行同一份 runner/profile-runner，Agent 的 `execution/` 旧导入位置保留薄转发，证据模块直接引用共享包，避免维护两套规则。

`LeaseGuard` 只依赖宿主提供的时间与租约快照：版本 1 服务端的 heartbeat 端口只读取执行状态，builtin 续租仅由 Worker 发起；external 由 API supervisor 根据 controller 活动期限续租。外部 Agent 通过 ExternalEngine 的决定端口驱动同一 runner，不能提交最终报告或内部命令。`checkpoint` 是可选持久化端口，必须在下一动作前保存已验证的进度；旧 HTTP 适配仍沿用步骤持久化行为。`decisionError` 可选端口记录单次决定的领域错误，使外部回执能区分进度已保存和后续动作失败，不改变内置 Agent 的纠错行为。

## 证据交付

`evidence/delivery.ts` 提供证据独立等待预算、撤权与超时诊断。执行器通过执行范围的下载接口读取截图并核对 SHA-256，再发送给视觉模型。`tests/agent/evidence-delivery.test.mjs` 直接引用本包构建产物，使用控制面状态夹具验证等待行为，不代表真实上传或浏览器验收。
