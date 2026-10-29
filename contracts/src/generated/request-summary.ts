/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

export interface RequestSummary {
  /**
   * 逻辑提交的稳定身份；重试沿用，重跑使用新身份。
   */
  requestId: string;
  /**
   * 展示标题首次接收后冻结，不生成或改写验证目标。
   */
  title: string;
  /**
   * 原记录创建时间；复用时不会改成本次请求时间。
   */
  createdAt: string;
  /**
   * 整请求重跑的来源；普通提交为 null。
   */
  sourceRequestId: string | null;
  /**
   * 判定算法版本，页面和导出必须一致。
   */
  aggregationVersion: 1;
  /**
   * 当前一致性读取快照时间，不代表执行结束。
   */
  generatedAt: string;
  /**
   * 当前范围内的 case 数。
   */
  caseCount: number;
  /**
   * 全部要求组已结束的 case 数，不代表验收通过。
   */
  finishedCaseCount: number;
  /**
   * 请求执行进度，不代表业务通过。
   */
  executionStatus: 'QUEUED' | 'IN_PROGRESS' | 'FINISHED';
  /**
   * 冻结执行组的生命周期计数；各分类互斥。
   */
  executionCounts: {
    /**
     * 该统计范围的总数，不能混同 case 数与执行次数。
     */
    total: number;
    /**
     * 仍在队列中的执行组数。
     */
    queued: number;
    /**
     * 正在运行的执行组数，包括等待人工处理。
     */
    running: number;
    /**
     * 执行完成组数，不等同于业务通过。
     */
    completed: number;
    /**
     * 被取消的执行组数，不直接视为产品失败。
     */
    cancelled: number;
    /**
     * 执行超时组数，不直接视为产品失败。
     */
    timedOut: number;
    /**
     * 异常终止组数，包含执行阻塞。
     */
    error: number;
  };
  /**
   * 全部要求组结束后为 FINAL，包括缺少报告的情况。
   */
  reportPhase: 'PENDING' | 'PARTIAL' | 'FINAL';
  /**
   * 所有要求组的业务结论；尚未全部结束时为 null。
   */
  reportStatus: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | null;
  /**
   * 报告齐全程度，不根据执行终态推测报告存在。
   */
  reportCoverage: {
    /**
     * 冻结要求或原始验收标准，不由汇总补造。
     */
    expected: number;
    /**
     * 已经交付报告的执行组数。
     */
    available: number;
    /**
     * 尚无报告的执行组数，终态仍可缺失。
     */
    missing: number;
  };
  /**
   * 已交付报告确认失败的唯一项数，部分结果期间也展示。
   */
  observedFailureCount: number;
  /**
   * 按 caseId 和 criterionId 去重。
   */
  uniqueCriteriaCounts: {
    /**
     * 该统计范围的总数，不能混同 case 数与执行次数。
     */
    total: number;
    /**
     * 满足该范围全部要求的通过数量。
     */
    passed: number;
    /**
     * 已交付结论中确认失败的数量。
     */
    failed: number;
    /**
     * 仍无法形成确定结论，包括通过与缺失并存。
     */
    inconclusive: number;
    /**
     * 未验收或所有要求组均缺失该项的数量。
     */
    skipped: number;
    /**
     * 尚有要求组未结束，且该项没有明确失败。
     */
    pending: number;
  };
  /**
   * 按模式汇总；未配置该模式的 case 不计缺失。
   *
   * @maxItems 1
   */
  byExecutionMode:
    | []
    | [
        {
          /**
           * 冻结的 LLM 执行模式。
           */
          executionMode: 'llm';
          /**
           * 当前范围内的 case 数。
           */
          caseCount: number;
          /**
           * 当前模式要求组中没有报告的数量。
           */
          missingReportCount: number;
          /**
           * 当前模式已交付报告的原单组统计。
           */
          criteriaCounts: {
            /**
             * 该统计范围的总数，不能混同 case 数与执行次数。
             */
            total: number;
            /**
             * 满足该范围全部要求的通过数量。
             */
            passed: number;
            /**
             * 已交付结论中确认失败的数量。
             */
            failed: number;
            /**
             * 仍无法形成确定结论，包括通过与缺失并存。
             */
            inconclusive: number;
            /**
             * 未验收或所有要求组均缺失该项的数量。
             */
            skipped: number;
          };
        },
      ];
}
