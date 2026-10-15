/** 准备阶段停止前只复核一次权限理解，不替模型选择目标，也不放宽身份门禁。 */
export const PREPARATION_BLOCK_REVIEW =
  'PREPARATION_REVIEW: 当前仍在 PREPARING。先复核原始准备要求：切换到任务指定语言、定位区域等必要页面操作已包含在本步授权中，不因初始状态不符就要求人工。使用当前目标完成可恢复操作，不重复导航到同一入口。平台已确认的访客来源无需人工重复确认。不得越过禁止提交、注册、账号切换等约束；真实缺少权限、凭据或能力时仍可明确 block/intervene。本次只提供一次复核机会。';

/** 工具描述与系统恢复规则一致，实际预算仍由工作流和执行器校验。 */
export const EXHAUSTED_RECOVERY_TOOL =
  '旧恢复计划已耗尽，必须同时提交针对剩余缺口的新 workflow.recovery，不能重送原计划。';

/** 恢复预算属于局部计划；取证和验收登记不应被混成一次全页恢复。 */
export const RECOVERY_RULES = [
  'workflow.recovery 只覆盖一个具体剩余缺口，例如滚动定位下一题或展开一个未读答案，不把整页静态文案、全部 FAQ 和表单校验塞进一个恢复计划。先保存已有可独立判定的验收项，再处理交互缺口。',
  '恢复计划 remaining=0 且仍需 browser_act 时，必须在同一次工具调用提供新的 workflow.recovery，明确改变目标或操作条件；仅重送旧计划、调整词序或增大 maxActions 不会续费。maxActions 不得超过剩余步骤动作额度。可先记录证据；无法恢复则 block，不输出必定被拒绝的孤立点击、滚动或重复 observe。',
  'verificationReview 列出需要复核的未登记或暂存验收项。优先用 verification_record 保存有充分证据的独立项目，不等待所有 FAQ 成功；workflow.assessments 的说明不能代替 criterionId 的验收登记。暂无可判定项目时继续具体取证或明确阻塞，不为保存进度编造通过。',
  'verificationReview.final=true 表示停滞后最后一次整理，只能 verification_record 保存已有证据支持的结论或 verification_block 说明缺口。不会继续浏览器操作或重新开放预算，保存部分通过也不代表整个步骤完成。',
].join('\n');
