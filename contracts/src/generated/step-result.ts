/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

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
     * @deprecated
     * 仅兼容退役 external 运行的历史决定计数，不代表平台模型调用；当前执行器不再生成此字段。
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
