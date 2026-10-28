# 真实 MCP 验证

你是本次被测 Codex 客户端。只使用 proofrun_browser 与 proofrun_verification 两套 MCP 完成下面的 Case。不要使用 shell、文件读取、HTTP、其他浏览器或其他工具代替 MCP 操作；不要写代码、修改 Case 标准或伪造证据。模型实际判断页面，不使用预设决定脚本。

## 调用流程

1. 读取两个 MCP 的 capabilities，按发现契约 validate_cases、submit_cases，executor.kind 为 external。
2. bind_run 后 get_context 等待 ACT。每次决定使用最新 controllerId/revision/page.observationId/stepId，独立稳定 UUID operationId；返回回执后 operation_get 至终态，再 get_context。不要用旧观察的 targets。
3. 按 PREPARING → CHECKING → VERIFYING → CLEANUP 执行。准备阶段根据页面登记 requirements 并 finish_step；CHECKING 必须重新核对 policy，不允许 browser.act；VERIFYING 用 browser_act 填写和保存，record 原 criterionId 的结论，再 finish_step。清理真实点击删除，确认页面为空后 finish_step。
4. 进度中的 id、criterionId、items 全部来自上下文。EvidenceRefs 使用实际当前运行的 artifactId，不用 observationId 代替。完成准备和清理要附本步骤的新 evidenceRefs。读取至少一张真实截图的 content（原生图像），据实际 DOM 和图像判断。
5. 不因客户端超时重新保存；UNKNOWN 查原操作并报告不确定。get_context 不续期，必要时 touch_controller。不要在没有观察到要求事实时提交 complete 或 PASSED。
6. 读取最终 get_run/get_request 报告和 get_context 的 closureVerified，直到物理关闭已确认。最终用中文说明 requestId、runId、各阶段事实、criteria 结论、清理结果、证据 ID 和 closureVerified。失败如实报告，不能为了通过而更改验收标准。

## 本次冻结 Case

下方 JSON 由联调宿主给定，原样用于验证及提交：
