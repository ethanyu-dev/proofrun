/** 准备阶段停止前只复核一次权限理解，不替模型选择目标，也不放宽身份门禁。 */
export const PREPARATION_BLOCK_REVIEW = `PREPARATION_REVIEW: 当前仍在 PREPARING。
先复核原始准备要求：切换到任务指定语言、定位区域等必要页面操作已包含在本步授权中，不因初始状态不符就要求人工。
使用当前目标完成可恢复操作，不重复导航到同一入口。
平台已确认的访客来源无需人工重复确认。
不得越过禁止提交、注册、账号切换等约束；真实缺少权限、凭据或能力时仍可明确 block/intervene。
本次只提供一次复核机会。`;

/** 等待未命中只说明预期尚未确认；恢复须基于新观察，不能重放此前的业务写入。 */
export const WAIT_NOT_MET_FEEDBACK = `本次有界等待未确认预期文本。
重新观察当前页面并核对等待条件；不能据此判定业务失败，也不要重复此前的提交。`;

/** 幂等重送已保存结论不能推进执行；保留补证机会，也给模型明确的退出路径。 */
export const REPEATED_RECORD_FEEDBACK = `CRITERIA_ALREADY_RECORDED:
本批结论已保存，同判定重送不会更新说明或增加动作消耗。
请继续具体未完成的取证；若已有充分证据完成全部步骤，
使用 verification_finish（progress.criteria 可以为空）；若缺口无法补齐，
使用 verification_block 说明已尝试动作、现有证据和缺失前提。
不要再次重送相同结论。`;
