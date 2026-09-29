/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

export interface CaseResultV2 {
  /**
   * 原始请求的幂等身份。
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
  /**
   * 按实际串行顺序返回各步骤进度，故障不抹掉已完成结论。
   */
  steps: StepResult[];
  /**
   * 独立业务清理任务的身份、状态与结果；没有清理定义时为 null。
   */
  cleanup: null | {
    taskId: string;
    status: 'PENDING' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'TIMED_OUT' | 'ERROR' | 'SKIPPED';
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
  };
}
export interface StepResult {
  /**
   * 对应规范化步骤的稳定身份。
   */
  stepId: string;
  /**
   * 执行生命周期，与 criteria 中的业务验收结论分开。
   */
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'BLOCKED' | 'ERROR' | 'SKIPPED';
  /**
   * 该步骤已观察事实或未完成原因。
   */
  summary: string;
  /**
   * 本步骤执行事实引用的控制面证据身份。
   */
  evidenceRefs: string[];
  /**
   * 仅包含本步骤已执行的验收项，未执行步骤为空。
   */
  criteria: {
    criterionId: string;
    verdict: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'SKIPPED';
    summary: string;
    evidenceRefs: string[];
  }[];
  /**
   * 步骤开始时间；未开始为 null。
   */
  startedAt: string | null;
  /**
   * 步骤结束时间；未结束或无法确认时为 null。
   */
  finishedAt: string | null;
}
