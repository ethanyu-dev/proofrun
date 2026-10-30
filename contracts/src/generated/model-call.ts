/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

export interface ModelCall {
  /**
   * 一次真实模型 HTTP 请求的稳定身份，重试产生新的调用记录。
   */
  id: string;
  /**
   * 当前执行内的模型请求顺序；历史混合策略的子请求也单独计数。
   */
  callIndex: number;
  /**
   * 执行循环的决策轮次；新循环每轮至多一个模型请求。
   */
  decisionIndex: number;
  /**
   * 实际发送的模型名称。
   */
  model: string;
  /**
   * 新调用只接受 DECISION；FIELD_VALUE 仅供单 LLM 历史调用记录解码。
   */
  purpose: 'DECISION' | 'FIELD_VALUE';
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
   * 供应商返回的 model、choices、usage 字段 JSON；历史调用可含 answers，未接收或清理后为空。
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
  stepId?: string;
  /**
   * 当前决策纠错链的实际尝试次数，由执行器记录；缺失的历史记录不推算。
   */
  attempt?: number;
  /**
   * 连续决策错误上限；不承诺剩余预算足够执行下一次重试。
   */
  maxAttempts?: number;
  /**
   * 派发前计算的单次请求时限上限；存档后仍按剩余步骤期限收紧，不延长执行预算。
   */
  timeoutMs?: number;
  /**
   * 封闭诊断字段，不包含原始正文、地址、认证头或任意供应商文本。
   */
  diagnostics?: {
    /**
     * 失败发生阶段；REQUEST 不能进一步区分建连与等待响应头。
     */
    phase: 'REQUEST' | 'RESPONSE_BODY' | 'RESPONSE_PARSE' | 'HTTP_STATUS';
    /**
     * 已收到的 HTTP 状态；未收到响应头时为空。
     */
    httpStatus: number | null;
    /**
     * 归一化响应媒体类型；不保存原始头参数，缺失时为空。
     */
    contentType: 'application/json' | 'text/html' | 'text/plain' | 'other' | null;
    /**
     * 已读完整正文的结构类别，未读完时为 unknown。
     */
    responseFormat: 'json' | 'html' | 'text' | 'empty' | 'unknown';
    /**
     * 已完整读取的响应字节数；未读完或超限时为空。
     */
    responseBytes: number | null;
    /**
     * 按状态及有限特征生成的分类摘要，不复制供应商错误消息。
     */
    reason:
      | 'RATE_LIMITED'
      | 'GATEWAY_TIMEOUT'
      | 'UPSTREAM_UNAVAILABLE'
      | 'AUTH_REJECTED'
      | 'CONTEXT_LIMIT'
      | 'INVALID_RESPONSE'
      | 'REQUEST_TIMEOUT'
      | 'TRANSPORT_FAILURE'
      | 'RESPONSE_TOO_LARGE';
  };
}
