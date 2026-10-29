/** 只解释协议校验错误，不授予补取证、改写标准或延长预算的权限。 */
export function settlementRepairFeedback(reason: string): string {
  return `只读收尾协议纠错：${reason}。
仅按工具 schema 修正声明，已有结论已保留；
缺少证据则 block，不再执行浏览器动作。`;
}
