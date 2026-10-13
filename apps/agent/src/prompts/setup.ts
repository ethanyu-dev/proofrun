/** 环境准备的证据与交接规则；原始要求直接来自 schema，不从页面关键词推断身份。 */
export const SETUP_RULES = [
  'environmentReview.required=true 时仅声明原始任务的共享环境意图：要求清除登录、未登录或访客时使用 verification_environment(mode=guest)，否则 configured 并解释依据。只依据原始 description/policy/session 配置，不按当前页面图标猜测要求。意图声明不是准备成功证明；平台会验证隔离访客来源或要求当前会话人工明确确认。不得用 configured 回避任务的访客要求。',
  'guest 模式的新 profile 不恢复认证快照；其他配置下本阶段不能自动清除认证，必须请求人工退出登录并确认，只有当前代次的逐项确认有效。Cookie 清理只在 cleanup 可用；没有工具回执不得声称自己已清除 Cookie。团队图标、无用户名、未展开用户菜单均不能证明未登录。',
  'executionStep.type=setup 且不是 cleanup 时为环境准备门禁。先完成登录状态、指定身份、团队角色、绑定状态及其他原始前置要求，全部就绪后平台才允许执行后续业务步骤。',
  'workflow.steps 分别保留 setup 描述和每条 policy。对每项要求逐一提交 assessments，只有真实观察或明确的本会话人工前置确认支持时才声明 complete，并附当前阶段的 evidenceRefs。未核实必须填 incomplete 或 blocked，不能把已尝试、打开页面、普通账号显示名或个人工作区标签当作角色或绑定状态证明。',
  '角色、团队成员关系、第三方绑定状态应从对应账号设置、成员详情等权威页面核实；页面文字出现某词、某入口存在或登录态复用成功都不能代替账号资格证明。原始 preconditions 的人工确认只证明其明确描述的条件，不能扩展到其他要求。',
  '无法核实或无法满足准备要求时立即 verification_intervene，列出缺失条件和需人工处理的事项。不能先执行后续业务、反复滚动或等待来消耗预算。登录缺失的交接填写 reasonCode=LOGIN_REQUIRED；其他问题按 workflow 中未完成项逐条说明。不同未解决条件可分别交接，每次执行最多三轮，同一条件只交接一次；不能靠改写原因反复申请。未授权人工时使用 verification_block。',
  '人工交还后重新观察并重新评估所有准备项，不能凭“人工已完成”直接 finish；旧账号、旧环境的完成声明与证据不能再次使用。仍有未解决条件时明确列出，各项均需核实；已交接过且仍未解决的条件使用 block，平台归类为不符合验证环境。环境未 ready 时平台停止全部后续执行，包括 cleanup；不能提前退出登录或清除现场。',
  'setup 即使没有 expected 也必须通过逐条 workflow 完成校验；只用 finish 一次提交当前准备结果，不用 verification_record。准备结果不得冒充产品验收失败。显式 wait 仅证明已等待，仍须核实其他原始条件。',
].join('\n');
