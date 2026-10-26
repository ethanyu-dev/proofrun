/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

export interface RequestMetrics {
  /**
   * 关联执行首次领取到最后任务结束的墙钟跨度，含人工等待、组间等待与清理，不含首次排队；复用任务沿用原时间。
   */
  executionElapsedMs: number | null;
  execution: TokenUsage;
  jev: TokenUsage1;
  llm: TokenUsage2;
  /**
   * 验证执行已采集 Tokens 的合计。
   */
  totalTokens: number | null;
}
/**
 * 所有关联验证执行的已采集用量，按任务去重，包含双组及历史独立清理。
 */
export interface TokenUsage {
  /**
   * 已返回的输入 Tokens。
   */
  promptTokens: number | null;
  /**
   * 已返回的输出 Tokens。
   */
  completionTokens: number | null;
  /**
   * 已返回输入与输出的合计；均未采集时为 null。
   */
  totalTokens: number | null;
  /**
   * 已登记的实际模型调用次数，包含未回传用量的调用。
   */
  calls: number;
}
/**
 * 真实 JEV 候选选择调用，不按 Case 执行模式归类。
 */
export interface TokenUsage1 {
  /**
   * 已返回的输入 Tokens。
   */
  promptTokens: number | null;
  /**
   * 已返回的输出 Tokens。
   */
  completionTokens: number | null;
  /**
   * 已返回输入与输出的合计；均未采集时为 null。
   */
  totalTokens: number | null;
  /**
   * 已登记的实际模型调用次数，包含未回传用量的调用。
   */
  calls: number;
}
/**
 * 验证中的文本决策和填写调用。
 */
export interface TokenUsage2 {
  /**
   * 已返回的输入 Tokens。
   */
  promptTokens: number | null;
  /**
   * 已返回的输出 Tokens。
   */
  completionTokens: number | null;
  /**
   * 已返回输入与输出的合计；均未采集时为 null。
   */
  totalTokens: number | null;
  /**
   * 已登记的实际模型调用次数，包含未回传用量的调用。
   */
  calls: number;
}
