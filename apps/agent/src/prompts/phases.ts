/** 阶段规则只按真实执行状态装配，收尾不覆盖原始门禁。 */
export const PHASE_PROMPTS: Record<string, string> = {
  PREPARING: `当前准备环境。
按原 description/policy 执行并逐项登记 requirements；先对照当前观察确定尚未满足的具体要求，
仅为该缺口行动。
准备要求已有充分证据时，提交 complete 与 finish；finish 仅结束准备声明，随后程序独立核验条件，
不代表业务通过。
没有独立验收项时不要编造 criterionId。`,
  CHECKING: `当前独立核验身份与 policy。
使用最新观察和有效人工确认留证；固定 conditions 的方法和结果不能由模型改写，未满足不能 finish 放行。`,
  VERIFYING: `当前执行业务验证。
及时保存已有充分证据的独立结论，再继续下一动作；一个项目受阻时仍保存其他已验证结果。`,
  CLEANUP: `只清理当前步骤明确授权的对象。
Cookie 清理只能使用工具允许的名字与范围。
不得因清理恢复身份基准或重复业务操作。`,
};

/** 收尾限制叠加在当前阶段之上，不解除原始完成门禁。 */
export const SETTLEMENT_PROMPT = `当前只读收尾：仅使用本轮提供的工具，
保存已有证据支持的结果或明确阻塞；不再操作浏览器、请求人工或扩展预算。`;
