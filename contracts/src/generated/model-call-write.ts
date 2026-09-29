/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

export type ModelCallWrite =
  | {
      phase: 'start';
      record: ModelCall;
    }
  | {
      phase: 'finish';
      result: {
        /**
         * worker 收到回复或错误的时间，未收到回执时为空。
         */
        finishedAt: string | null;
        /**
         * 仅表示请求接收状态，收到回复不等于模型决定有效或业务验收通过。
         */
        status: 'PENDING' | 'RECEIVED' | 'ERROR';
        /**
         * 供应商返回的 choices、answers、usage 等已选择字段 JSON，未接收或清理后为空。
         */
        response: string | null;
        /**
         * 稳定错误码，不保存带地址或凭据的原始异常文本。
         */
        error: string | null;
        /**
         * 供应商返回的输入用量，未报告则为空。
         */
        promptTokens: number | null;
        /**
         * 供应商返回的输出用量，未报告则为空。
         */
        completionTokens: number | null;
        /**
         * 一次供应商请求的耗时，不含记录交付。
         */
        elapsedMs: number | null;
      };
    };

export interface ModelCall {
  /**
   * 一次真实模型 HTTP 请求的稳定身份，重试产生新的调用记录。
   */
  id: string;
  /**
   * 当前执行内的模型请求顺序，混合策略的子请求也单独计数。
   */
  callIndex: number;
  /**
   * 执行循环的决策轮次，同一轮可能调用多个模型。
   */
  decisionIndex: number;
  /**
   * 实际发送的模型名称。
   */
  model: string;
  /**
   * 请求用于决策、候选选择或填写值生成。
   */
  purpose: 'DECISION' | 'JEV_SELECTION' | 'FIELD_VALUE';
  /**
   * worker 在派发请求前记录的时间。
   */
  startedAt: string;
  /**
   * worker 收到回复或错误的时间，未收到回执时为空。
   */
  finishedAt: string | null;
  /**
   * 仅表示请求接收状态，收到回复不等于模型决定有效或业务验收通过。
   */
  status: 'PENDING' | 'RECEIVED' | 'ERROR';
  /**
   * 实际请求正文 JSON，图片 base64 替换为证据引用；保留策略清理后为空。
   */
  request: string | null;
  /**
   * 原始请求正文（含图片）的摘要，用于比对派发内容。
   */
  requestSha256: string;
  /**
   * 供应商返回的 choices、answers、usage 等已选择字段 JSON，未接收或清理后为空。
   */
  response: string | null;
  /**
   * 稳定错误码，不保存带地址或凭据的原始异常文本。
   */
  error: string | null;
  /**
   * 供应商返回的输入用量，未报告则为空。
   */
  promptTokens: number | null;
  /**
   * 供应商返回的输出用量，未报告则为空。
   */
  completionTokens: number | null;
  /**
   * 一次供应商请求的耗时，不含记录交付。
   */
  elapsedMs: number | null;
  /**
   * 正文中被替换为证据引用的图片数量。
   */
  imagesOmitted: number;
  /**
   * 正文是否已按任务保留策略清理。
   */
  archived: boolean;
}
