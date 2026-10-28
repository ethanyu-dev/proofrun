/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

export interface RequestResultV2 {
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
   * 当前范围内的 case 数，双跑不增加数量。
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
   * 两组明确通过和失败相反的标准数，不含覆盖差异。
   */
  confirmedDisagreementCount: number;
  /**
   * 按 caseId 和 criterionId 去重，双跑不增加分母。
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
   */
  byExecutionMode: {
    /**
     * 冻结执行模式，按 LLM、JEV 顺序展示。
     */
    executionMode: 'llm' | 'jev';
    /**
     * 当前范围内的 case 数，双跑不增加数量。
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
  }[];
  /**
   * 首次接收冻结的成员与顺序，不按当前筛选截断。
   */
  cases: {
    /**
     * 全局 case 幂等身份，不改为请求内局部身份。
     */
    caseId: string;
    /**
     * 展示标题首次接收后冻结，不生成或改写验证目标。
     */
    title: string;
    /**
     * 接收时创建或复用的冻结事实，不因重提改变。
     */
    executionOrigin: 'created' | 'reused';
    /**
     * 整请求重跑对应的原 case；普通提交为 null。
     */
    sourceCaseId: string | null;
    /**
     * 所有要求组的业务结论；尚未全部结束时为 null。
     */
    reportStatus: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | null;
    /**
     * 全部要求组进入终态，不代表业务通过。
     */
    finished: boolean;
    /**
     * 按业务标准身份对齐的各组结论，清理不计入。
     */
    criteria: {
      /**
       * 原 expected 的稳定身份；跨 case 用复合身份关联。
       */
      criterionId: string;
      /**
       * 排序不改变的冻结步骤身份。
       */
      stepId: string;
      /**
       * 调用方的说明，不添加额外验证要求。
       */
      description: string;
      /**
       * 调用方明确声明的单条验收标准。
       */
      expectedResult: string;
      /**
       * 当前层级的执行或验收状态，不能跨层级解释。
       */
      status: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'SKIPPED' | 'PENDING';
      /**
       * 两组存在相反的明确通过和失败判断。
       */
      disagreement: boolean;
      /**
       * 两组覆盖不同，不当作明确判断冲突。
       */
      coverageDifference: boolean;
      /**
       * 首次接收冻结的实际执行组，不随平台配置变化。
       */
      arms: {
        /**
         * 原执行任务身份，用于报告和证据追溯。
         */
        taskId: string;
        /**
         * 冻结执行模式，按 LLM、JEV 顺序展示。
         */
        executionMode: 'llm' | 'jev';
        /**
         * 该执行组该项原始判断；无报告时为 null。
         */
        verdict: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'SKIPPED' | null;
        /**
         * 报告已交付的观察和依据，汇总不会再次生成。
         */
        summary: string;
        /**
         * 只引用当前 case 和执行组登记的证据。
         */
        evidenceRefs: string[];
      }[];
    }[];
    /**
     * 首次接收冻结的实际执行组，不随平台配置变化。
     */
    arms: {
      /**
       * 原执行任务身份，用于报告和证据追溯。
       */
      taskId: string;
      /**
       * 冻结执行模式，按 LLM、JEV 顺序展示。
       */
      executionMode: 'llm' | 'jev';
      /**
       * 原记录创建时间；复用时不会改成本次请求时间。
       */
      createdAt: string;
      /**
       * 证据清理时间；原结论保留，下载应禁用。
       */
      archivedAt: string | null;
      result: CaseResultV2;
    }[];
    /**
     * 冻结的步骤定义，准备、业务验证和后续清理分别展示。
     */
    steps: {
      /**
       * 排序不改变的冻结步骤身份。
       */
      stepId: string;
      /**
       * 原步骤类型，保持执行顺序与准备门禁。
       */
      type: 'setup' | 'verification';
      /**
       * 调用方的说明，不添加额外验证要求。
       */
      description: string;
      /**
       * 冻结要求或原始验收标准，不由汇总补造。
       */
      expected: string[];
      /**
       * 后续清理独立展示，不进入业务统计。
       */
      cleanup: boolean;
    }[];
  }[];
  metrics?: RequestMetrics;
}
/**
 * 原单组公开结果，不能代表另一组。
 */
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
      kind: 'DOM' | 'SCREENSHOT' | 'NETWORK' | 'TRACE' | 'RUNTIME';
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
   * 业务清理状态与结果；新任务的 taskId 指向原任务，历史独立清理保留旧身份；没有清理定义时为 null。
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
        kind: 'DOM' | 'SCREENSHOT' | 'NETWORK' | 'TRACE' | 'RUNTIME';
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
  /**
   * 验证报告状态：通过、未通过、无法判定；无报告时为 null。执行状态不等于验收结论，已确认失败优先于未覆盖项。
   */
  reportStatus: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | null;
  /**
   * 按本次验收定义统计，各分类之和等于 total；无报告时为 null。
   */
  criteriaCounts: null | {
    /**
     * 本次定义的验收项总数。
     */
    total: number;
    /**
     * 通过项数。
     */
    passed: number;
    /**
     * 未通过项数。
     */
    failed: number;
    /**
     * 已验收但无法判定的项数。
     */
    inconclusive: number;
    /**
     * 未验收或报告缺失的项数。
     */
    skipped: number;
  };
  /**
   * 最近一次领取检查发现的排队原因；成功领取后清空，取消或排队超时后保留。null 或缺失表示尚无诊断，不表示一定可执行。
   */
  queueReason?: null | QueueReason;
  /**
   * 双跑时返回两组独立结果；顶层字段兼容纯 LLM 主组，不代表两组汇总结论。单组任务省略。
   */
  comparison?: {
    id: string;
    /**
     * @minItems 2
     * @maxItems 2
     */
    arms: [
      {
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
            kind: 'DOM' | 'SCREENSHOT' | 'NETWORK' | 'TRACE' | 'RUNTIME';
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
         * 业务清理状态与结果；新任务的 taskId 指向原任务，历史独立清理保留旧身份；没有清理定义时为 null。
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
              kind: 'DOM' | 'SCREENSHOT' | 'NETWORK' | 'TRACE' | 'RUNTIME';
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
        /**
         * 验证报告状态：通过、未通过、无法判定；无报告时为 null。执行状态不等于验收结论，已确认失败优先于未覆盖项。
         */
        reportStatus: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | null;
        /**
         * 按本次验收定义统计，各分类之和等于 total；无报告时为 null。
         */
        criteriaCounts: null | {
          /**
           * 本次定义的验收项总数。
           */
          total: number;
          /**
           * 通过项数。
           */
          passed: number;
          /**
           * 未通过项数。
           */
          failed: number;
          /**
           * 已验收但无法判定的项数。
           */
          inconclusive: number;
          /**
           * 未验收或报告缺失的项数。
           */
          skipped: number;
        };
        /**
         * 最近一次领取检查发现的排队原因；成功领取后清空，取消或排队超时后保留。null 或缺失表示尚无诊断，不表示一定可执行。
         */
        queueReason?: null | QueueReason;
        executionMode: 'llm' | 'jev';
        taskId: string;
        executionOutcome?: ExecutionOutcome;
        /**
         * 本次运行的主任务身份，历史记录按此身份读取。
         */
        runId?: string;
      },
      {
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
            kind: 'DOM' | 'SCREENSHOT' | 'NETWORK' | 'TRACE' | 'RUNTIME';
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
         * 业务清理状态与结果；新任务的 taskId 指向原任务，历史独立清理保留旧身份；没有清理定义时为 null。
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
              kind: 'DOM' | 'SCREENSHOT' | 'NETWORK' | 'TRACE' | 'RUNTIME';
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
        /**
         * 验证报告状态：通过、未通过、无法判定；无报告时为 null。执行状态不等于验收结论，已确认失败优先于未覆盖项。
         */
        reportStatus: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | null;
        /**
         * 按本次验收定义统计，各分类之和等于 total；无报告时为 null。
         */
        criteriaCounts: null | {
          /**
           * 本次定义的验收项总数。
           */
          total: number;
          /**
           * 通过项数。
           */
          passed: number;
          /**
           * 未通过项数。
           */
          failed: number;
          /**
           * 已验收但无法判定的项数。
           */
          inconclusive: number;
          /**
           * 未验收或报告缺失的项数。
           */
          skipped: number;
        };
        /**
         * 最近一次领取检查发现的排队原因；成功领取后清空，取消或排队超时后保留。null 或缺失表示尚无诊断，不表示一定可执行。
         */
        queueReason?: null | QueueReason;
        executionMode: 'llm' | 'jev';
        taskId: string;
        executionOutcome?: ExecutionOutcome;
        /**
         * 本次运行的主任务身份，历史记录按此身份读取。
         */
        runId?: string;
      },
    ];
  };
  executionOutcome?: ExecutionOutcome;
  /**
   * 本次运行的主任务身份，历史记录按此身份读取。
   */
  runId?: string;
  /**
   * 本组实际任务身份；caseId 在重跑间保持不变。
   */
  taskId?: string;
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
  /**
   * 稳定的未完成原因码，预算耗尽按受阻记录。
   */
  reasonCode?: string | null;
  /**
   * 本步骤实际用量；清理多步各记录增量，额度由整段清理共享。业务耗时排除人工等待。
   */
  budgetUsage?: {
    elapsedMs: number;
    modelCalls: number;
    actions: number;
    limit: {
      timeoutMs: number;
      maxActions: number;
      maxModelCalls: number;
    };
    /**
     * 外部决定计数；不代表平台模型调用。
     */
    decisionCalls?: number;
  };
  /**
   * @maxItems 64
   */
  preconditions?: {
    id: string;
    description: string;
    status: 'SATISFIED' | 'UNSATISFIED' | 'UNCONFIRMED';
    source: 'observation' | 'human' | 'platform';
    /**
     * @maxItems 32
     */
    evidenceRefs: string[];
    controlRevision?: number;
    authRevision?: number;
  }[];
  /**
   * 阻塞时冻结的条件与页面证据；后续清理不能替换该快照。
   */
  blockage?: {
    /**
     * @maxItems 128
     */
    conditions: {
      id: string;
      description: string;
      summary: string;
      status: 'UNCONFIRMED' | 'UNSATISFIED';
    }[];
    evidenceRefs: string[];
    /**
     * 执行器冻结阻塞记录的时间，不冒充节点截图拍摄时间。
     */
    recordedAt: string;
    /**
     * 截图未取得时保留原因，不覆盖原始阻塞原因。
     */
    screenshotError?: string;
  };
  groupId?: string;
  /**
   * 环境准备先操作再检查 policy，READY 才允许本组验证。
   */
  phase?: 'PREPARING' | 'CHECKING' | 'READY' | 'VERIFYING' | 'CLEANUP';
  /**
   * 子项阅读进度与原文证据，不代表原验收标准已通过。
   *
   * @maxItems 32
   */
  readings?: {
    id: string;
    name: string;
    heading: string;
    status: 'pending' | 'observed' | 'recorded';
    quote?: string;
    /**
     * @maxItems 24
     */
    evidenceRefs: string[];
  }[];
  /**
   * @maxItems 32
   */
  environmentHistory?: {
    reason: string;
    /**
     * @maxItems 128
     */
    conditions: {
      id: string;
      description: string;
      summary: string;
      status: 'UNCONFIRMED' | 'UNSATISFIED';
    }[];
    controlRevision: number;
    authRevision: number;
    recordedAt: string;
  }[];
  /**
   * 原始要求完成声明，只是带来源的执行记录，不替代业务验收。
   *
   * @maxItems 33
   */
  requirements?: {
    id: string;
    status: 'pending' | 'recorded' | 'incomplete' | 'blocked';
    summary?: string;
    /**
     * @maxItems 24
     */
    evidenceRefs: string[];
  }[];
}
/**
 * 最近一次领取检查发现的排队原因；不包含节点身份或登录凭据，也不是业务验收结论。
 */
export interface QueueReason {
  code:
    | 'CLEANUP_PARENT_PENDING'
    | 'CLEANUP_PARENT_MISSING'
    | 'CLEANUP_NODE_CONFLICT'
    | 'AUTH_NODE_ROUTE_CONFLICT'
    | 'COMPARISON_NODE_CONFLICT'
    | 'RESOURCE_BUSY'
    | 'NO_ELIGIBLE_NODE'
    | 'NODE_CAPACITY'
    | 'NODE_ROTATING'
    | 'SESSION_BUDGET_UNSUPPORTED'
    | 'IDENTITY_BUSY'
    | 'IDENTITY_UNAVAILABLE'
    | 'EXTERNAL_ACCOUNT_WAIT';
  message: string;
}
/**
 * 执行原因投影；不改写生命周期与验收结论，终止原因不覆盖已确认的环境阻塞。
 */
export interface ExecutionOutcome {
  /**
   * 面向用户的执行分类，与验收结果分开。
   */
  category:
    | 'QUEUED'
    | 'RUNNING'
    | 'COMPLETED'
    | 'CANCELLED'
    | 'WAITING_HUMAN'
    | 'HUMAN_TIMEOUT'
    | 'ENVIRONMENT_BLOCKED'
    | 'EXECUTION_BLOCKED'
    | 'QUEUE_TIMEOUT'
    | 'EXECUTION_TIMEOUT'
    | 'BUDGET_EXHAUSTED'
    | 'WORKER_ERROR'
    | 'NODE_ERROR'
    | 'SESSION_ERROR'
    | 'MODEL_ERROR'
    | 'SERVICE_ERROR'
    | 'BROWSER_ERROR'
    | 'CLEANUP_ERROR'
    | 'EXECUTION_ERROR'
    | 'HUMAN_UNEXECUTABLE'
    | 'CAPABILITY_ERROR';
  /**
   * 主要原因；旧 AGENT_ERROR 可由报告具体原因细分。
   */
  reasonCode: string | null;
  /**
   * 控制面原始终止码，不覆盖主要环境阻塞。
   */
  terminationCode: string | null;
  /**
   * 当前未完成人工请求原文，不参与自然语言分类。
   */
  detail: string | null;
  /**
   * 本轮人工请求开始时间，历史缺失为 null。
   */
  waitingSince: string | null;
  /**
   * 本轮固定等待截止时间，历史缺失为 null。
   */
  waitDeadline: string | null;
}
/**
 * 详情与导出的同一快照统计；旧服务和列表可省略。
 */
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
