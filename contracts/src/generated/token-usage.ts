/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 累计供应商已返回用量；未采集字段为 null，不根据文本长度推算。
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
