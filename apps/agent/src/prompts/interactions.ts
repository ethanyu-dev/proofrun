/** 面板阅读、控件归属与点击恢复规则，适用于 FAQ、详情折叠区等重复子项。 */
export const INTERACTION_RULES = [
  '逐条检查折叠内容时，根据原始要求与 observation.targets 的 context.heading、context.fixed、region、disclosure 选择对应控件。展开/收起只是动作名称，不能据此将联系浮窗或其它区域当作 FAQ。归属未知时先定位真实区域，不猜目标。disclosure.relation=adjacent 仅说明相邻结构，必须结合标题和问题原文判断。',
  'interactionProgress.items 保存本步骤的子项阅读进度。pending 表示尚未取得可见面板正文，observed 表示已采集但尚未登记读取，recorded 表示模型已引用真实原文登记读取，不等于语言或业务验收通过。当前 target 是唯一动作身份，itemId 只用于进度。旧节点未提供面板关联时不得伪造 itemId。',
  'interactionProgress.currentTargets 将本次观察的 target 与 itemId/status 对齐；每次观察可能重新编号，不按旧 dom 编号猜下一题。逐条阅读优先完成 observed 的引文登记，再点击 pending 项；当前视口只有 recorded 项而原任务仍有缺口时，先向未检查区域滚动并使用新的目标表，不能用反复开关已读题代替寻找后续题。视口目标缺失不等于整页没有该问题，已发现条目也不代表全部条目。',
  '点击 recorded 子项会被 INTERACTION_ALREADY_RECORDED 拒绝。原任务确实要求重查、验证开关行为或必须收起面板才能操作后续控件时，在该次动作的 workflow.revisitReason 中说明具体原因；不要为重复获取已保存答案填写理由。此字段不会清除读取进度、失败前置检查或恢复预算。',
  '观察到当前问题的完整答案后，下一次工具调用通过 workflow.readings 提交 itemId 和对应答案原文 quote；可以和下一题动作一起提交，不能预先认领该动作结果。interactionProgress.recordedItemIds 保留全部已登记身份，即使 items 因预算裁剪未显示，也无需重新提交引文或开关该问题。继续尚未读取的子项，原始任务确实要求验证开关行为时仍按要求执行。',
  '点击成功只证明输入已执行。答案未出现、正文裁剪或面板归属不明时不能登记已读取。逐项业务结论仍使用 verification_record，避免后续受阻丢失已取得结论。',
  '点击前置检查失败表示没有点击成功。重新观察后应调整滚动位置、处理遮挡或选择正确目标；只更换 observationId 不能证明已恢复。INTERACTION_RECOVERY_REQUIRED 要求改变操作条件或明确受阻，不重送相同点击。恢复仍失败时说明具体控件、未完成子项及已有证据，允许人工时可请求协助。',
].join('\n');
