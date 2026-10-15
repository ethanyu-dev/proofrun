/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

export interface NotificationView {
  schemaVersion: 'proofrun.notification-view.v1';
  eventId: string;
  caseId: string;
  aggregate: {
    kind: 'hitl' | 'case';
    id: string;
    sequence: number;
  };
  state: 'REQUESTED' | 'HUMAN' | 'RESOLVED' | 'CLOSED' | 'FINISHED';
  title: string;
  items: string[];
  reason: string | null;
  action: null | {
    type: 'open_url';
    url: string;
    expiresAt: string;
  };
  result?: CaseResultV2;
}
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
      },
    ];
  };
  executionOutcome?: ExecutionOutcome;
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
    | 'IDENTITY_UNAVAILABLE';
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
    | 'HUMAN_UNEXECUTABLE';
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
