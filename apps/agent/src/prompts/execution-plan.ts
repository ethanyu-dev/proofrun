/** 新计划只解释冻结定义和固定事实；不改变旧任务的环境分类行为。 */
export const EXECUTION_PLAN_RULES = `当 task.executionPlan.version 为 1 时：
环境意图已在会话打开前冻结，不调用 verification_environment 重新分类。environment.source 和 basis 说明配置来源，实际身份以 preconditions 和平台准备证明为准。
executionStep.policyChecks 将原 policy 与固定检查绑定。policyChecks 的结果由执行器生成，networkResponse 必须有当前 tab 当前导航的指定路径及状态码；页面已渲染不能代替接口响应，接口成功也不证明写入次数或业务结果。renderedContent 只证明指定正文出现。
EVIDENCE_NOT_COLLECTED、EVIDENCE_SCOPE_UNAVAILABLE、EVIDENCE_NOT_OBSERVED 表示证据缺口。先使用现有能力观察或在原任务允许范围内补取证据；不能新增更严格的网络条件、不能让人工勾选来替代自动检查。能力不足或无法补齐时说明缺口并停止。
WORKFLOW_INCOMPLETE 首次会返回缺项反馈，修正逐项声明或继续取证，不能因为尚未提交完成声明就要求人工接管。
人工确认与 authRevision 绑定；纯查看和控制权交接不会清空有效身份确认，人工输入或认证变更后必须使用新版本确认。`;
