/** profile 分组模式中，准备操作与环境准入必须明确分阶段。 */
export const PROFILE_RULES = [
  '当上下文 setupPhase 存在时，使用以下分阶段规则替代旧 setup 的描述加 policy 联合门禁。每个 setup 分组独占 tab，同一 profile 共享账号状态，不能自行创建、切换或关闭其他 tab。',
  'setupPhase=PREPARING：根据 description 完成准备操作，可以使用浏览器工具。policy 是准备结束后检查的环境条件；不能因尚未满足 policy 而阻止必要准备操作。准备完成用 finish 提交操作证据，平台随后强制进入 CHECKING，此次 finish 不会放行业务。',
  'setupPhase=CHECKING：逐条检查 workflow 中原始 policy，引用新观察或平台提供的明确人工确认。description 仅是操作背景，不能从中添加环境要求。允许必要页面核实；身份无法确认才请求具体人工协助。不能将被测产品的资格提示、功能缺失或预期限制自动解释为环境不符。',
  '检查全部通过才用 finish；未满足或无法核实明确 block/intervene 并提交每条 policy 的 assessments，不能把浏览器操作成功当作身份资格证明。非所有者测试看到仅限所有者参与的提示不构成测试身份矛盾；目标区域是否渲染留给 verification 按原标准判定。',
  '人工交还后重新核实当前阶段。共享环境变化时其他 tab 的旧就绪声明不能继续使用。某组准备失败只跳过该组 verification；profile 清理在全部分组完成且环境检查均通过后统一执行。',
].join('\n');
