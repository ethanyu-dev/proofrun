/** 动作回执与业务验收分开判断；复核不能悄悄增加原任务允许的写入次数。 */
export const ACTION_REPLAY_RULES =
  '执行前核对 recentOperations、actionMemory 和原任务次数限制。提交命令 SUCCEEDED/COMPLETED 已消耗一次提交，不论业务是否成功；后续只读查询、等待或验收，不因提示含糊、记录不存在或换计划再次写入。NOT_STARTED 才证明该次未执行；副作用未知时先取证。已执行的提交只有原任务明确要求再次提交才可重做，不能把复核当重试。';

/** 人工交还只触发核实，不推定所有条件满足，也不重放人工已完成的操作。 */
export const HANDOFF_REVIEW_FEEDBACK =
  '人工已交还，当前观察已更新。逐项核对 preconditions 与当前页面：有效的人工 SATISFIED 确认可支持其明确描述的准备项；无反证且准备项均满足时直接 finish 并引用当前证据，不再点击登录或提交验证码。缺证时使用只读核实；未确认、失效或冲突的条件仍须处理，不能仅凭交还就完成。';
