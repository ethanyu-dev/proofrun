/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * case 的执行状态和业务结果，不返回内部任务配置或节点信息。
 */
export interface CaseResult {
  /**
   * 原请求的本次验证身份。
   */
  caseId: string;
  /**
   * 执行生命周期；COMPLETED 不直接表示业务通过。
   */
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'TIMED_OUT' | 'ERROR';
  /**
   * 已交付的业务结果；尚无报告时为 null，包括部分异常终态。
   */
  result: null | {
    /**
     * 整体业务结论；BLOCKED 和 ERROR 不表示产品失败。
     */
    outcome: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'BLOCKED' | 'ERROR';
    /**
     * 基于本次证据的结果说明。
     */
    summary: string;
    /**
     * 按原验收项身份返回逐项结论。
     */
    criteria: {
      /**
       * 对应原 acceptanceCriteria 中的 id。
       */
      criterionId: string;
      /**
       * 逐项判断；未进行验收时为 SKIPPED。
       */
      verdict: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'SKIPPED';
      /**
       * 该项结论及证据支持范围。
       */
      summary: string;
      /**
       * 引用 evidence 数组中的证据身份。
       */
      evidenceRefs: string[];
    }[];
    /**
     * 报告引用的证据，下载范围限定于当前 case。
     */
    evidence: {
      /**
       * 平台登记的证据身份。
       */
      id: string;
      /**
       * 证据媒介，由平台取证配置决定。
       */
      kind: 'DOM' | 'SCREENSHOT' | 'NETWORK' | 'TRACE';
      /**
       * 本控制面的 case 证据地址，下载需要相同凭据。
       */
      url: string;
      /**
       * 原始下载字节的 SHA-256 小写十六进制摘要。
       */
      sha256: string;
    }[];
  };
}
