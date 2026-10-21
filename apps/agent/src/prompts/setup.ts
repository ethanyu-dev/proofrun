/** 环境准备的证据与交接规则；原始要求直接来自 schema，不从页面关键词推断身份。 */
export const SETUP_RULES = [
  'environmentReview.required=true 时仅声明原始任务的共享环境意图：要求清除登录、未登录或访客时使用 verification_environment(mode=guest)，否则 configured 并解释依据。只依据原始 description/policy/session 配置，不按当前页面图标猜测要求。意图声明不是准备成功证明；平台会验证隔离访客来源或要求当前会话人工明确确认。不得用 configured 回避任务的访客要求。',
  'guest 模式的新 profile 不恢复认证快照；其他配置下本阶段不能自动清除认证，必须请求人工退出登录并确认，只有当前代次的逐项确认有效。Cookie 清理只在 cleanup 可用；没有工具回执不得声称自己已清除 Cookie。团队图标、无用户名、未展开用户菜单均不能证明未登录。',
  'executionStep.type=setup 且不是 cleanup 时为环境准备门禁。先完成登录状态、指定身份、团队角色、绑定状态及其他原始前置要求，全部就绪后平台才允许执行后续业务步骤。',
  'workflow.steps 分别保留 setup 描述和每条 policy。对每项要求逐一提交 assessments，只有真实观察或明确的本会话人工前置确认支持时才声明 complete，并附当前阶段的 evidenceRefs。未核实必须填 incomplete 或 blocked，不能把已尝试、打开页面、普通账号显示名或个人工作区标签当作角色或绑定状态证明。',
  '角色、团队成员关系、第三方绑定状态应从对应账号设置、成员详情等权威页面核实；页面文字出现某词、某入口存在或登录态复用成功都不能代替账号资格证明。原始 preconditions 的人工确认只证明其明确描述的条件，不能扩展到其他要求。',
  '准备要求尚未满足时，先在原任务授权内完成必要页面操作：切换指定语言、展开菜单并选择已观察选项、定位目标区域不需要额外人工授权。初始语言不符不等于无法准备，不反复导航同一入口代替语言切换。不得扩大到注册、提交业务数据、切换未授权账号或绕过验证。确实缺少权限、凭据、能力或无法核实时才 verification_intervene，列出缺失条件；不能先执行后续业务。登录缺失填写 reasonCode=LOGIN_REQUIRED；其他问题按未完成项说明。同一条件只交接一次，每次执行最多三轮；未授权人工时使用 verification_block。',
  '人工交还后平台已重新观察。逐项核对当前 preconditions 与页面；有效的人工 SATISFIED 确认可证明其明确描述的准备项，当前无反证且全部满足即可 finish，不重放登录或验证码提交。缺证时只读核实，不能凭交还本身认定满足；旧账号、旧环境证据无效。已交接且仍未解决的条件使用 block；环境未 ready 时停止后续执行和 cleanup，保留现场。',
  'setup 即使没有 expected 也必须通过逐条 workflow 完成校验；只用 finish 一次提交当前准备结果，不用 verification_record。准备结果不得冒充产品验收失败。显式 wait 仅证明已等待，仍须核实其他原始条件。',
].join('\n');
