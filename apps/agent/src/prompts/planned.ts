/** 统一策略在一次请求中完成证据复核、局部规划和首个动作；禁止另建隐含聊天记忆。 */
export const PLANNED_RULES = `当前执行使用 planned-v1，以下字段约定替代旧版恢复计划约定：
1. 当前局部计划在 context.plan。提交新计划使用工具顶层 plan，不提交 workflow.recovery；workflow 仅记录原始要求完成声明、阅读引文和必要重访原因。
2. 首次浏览器动作必须同时提交 plan。计划只服务当前原始步骤，提供 goal、scope、terms、successCondition、allowedActions、maxActions；通常 maxActions=4，最大6且不得超过剩余动作额度。可同时保存本轮前已有证据结论并执行第一个动作，不先进行无意义观察。
3. plan.checkpoints 可选 after-fill、after-click、after-navigation。普通填写不要求逐次复核；若任务验证字段提示，应在完成必要触发动作后安排复核，或使用一个有界计划完成该过程。没有检查点也会在计划额度耗尽、异常或 JEV 请求时复核。
4. plan.inputs 可一次提供多个 {key,value}，key 必须来自本轮 inputFields。值只能来自任务事实或明确允许构造的测试数据；不得编造真实凭据。旧字段键、语义不明确的字段或密码不能缓存。缺少值时可在本次工具中直接填写合法测试值，或说明缺口。
5. plan.collectReadings=true 仅用于采集面板正文的目标。interactionProgress.status=observed 表示已取得正文，尚未完成语义验收；可批量采集后通过 workflow.readings 核对原文。需要测试开关行为时不要开启该选项。读取记录和计划成功均不等于业务通过。
6. executionPolicy.event 是本轮唯一主要路由原因。CHECKPOINT 时核对 successCondition，必要时记录已有结论并提供下一个计划；不能把 JEV 请求复核当作结果已被证实。
7. 同一计划改名、重复登记和改变观察编号不会恢复额度。实际错误、无法补齐的证据和原任务约束必须保留；无法继续时明确 block。身份与人工接管沿用平台规则。
8. 计划和动作只引用当前观察；历史正文仅为证据线索。只有本次调用前已取得且能核实内容的证据可以支持 findings，不能预先认领接下来动作的结果。`;

/** 复核原因独立于页面文本，不通过中文错误前缀控制执行流程。 */
export function plannedFeedback(code: string, detail?: string): string {
  return `统一执行复核 ${code}。${detail ?? ''} 依据当前原始要求、计划和实际证据决定下一步；必要时一次提交新计划与首个动作，或保存结论并明确缺口。`;
}
