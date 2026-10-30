/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 平台内部任务结构，含环境、调度和执行配置；外部调用使用 VerificationCase。
 */
export type VerificationTask = {
  caseDefinition?: VerificationCase;
  protocolVersion: '0.1';
  /**
   * 上层生成的不可变任务身份，也用于 HTTP 路径；相同身份只能提交相同定义。
   */
  taskId: string;
  objective: string;
  environment: {
    id: string;
    /**
     * 与节点注册一致的内网资源池标识。
     */
    nodePool: string;
    /**
     * 是否允许人工辅助；等待暂停执行时限，完成后重新计时二十分钟，人工不能修改验收标准。
     */
    allowIntervention?: boolean;
    /**
     * @deprecated
     * 历史登录槽元数据；不恢复或保存状态，仅保留显式 nodeId 的路由约束。
     */
    auth?: {
      /**
       * 节点私有登录状态名称，不是路径。
       */
      stateId: string;
      /**
       * 已退役的恢复开关，仅用于读取历史定义，不触发登录恢复。
       */
      restore: boolean;
      /**
       * 登录状态所属节点，调度固定到此节点。
       */
      nodeId: string;
    };
    /**
     * @deprecated
     * 已退役的自动登录复用开关，仅为历史结构兼容，不触发恢复、保存或节点偏好。
     */
    reuseAuth?: boolean;
  };
  target: {
    url: string;
  };
  /**
   * @minItems 0
   */
  acceptanceCriteria: {
    id: string;
    description: string;
    expectedResult: string;
    /**
     * @minItems 1
     */
    evidenceKinds: [
      'DOM' | 'SCREENSHOT' | 'NETWORK' | 'TRACE' | 'RUNTIME',
      ...('DOM' | 'SCREENSHOT' | 'NETWORK' | 'TRACE' | 'RUNTIME')[],
    ];
    /**
     * 结构化任务中所属步骤身份。
     */
    stepId?: string;
    /**
     * 本步骤必须具备的实际节点能力；文本推导只补充已识别的需求。
     */
    requiredCapabilities?: ('runtimeEvidenceV1' | 'networkDetailsV1' | 'focusRecoveryV1')[];
  }[];
  budget: {
    timeoutMs: number;
    maxActions: number;
  };
  /**
   * 仅支持 llm，省略时按 LLM 执行。
   */
  executionMode?: 'llm';
  caseV2Definition?: VerificationCaseV2;
  /**
   * 服务端规范化的串行步骤；每项均有稳定 stepId。
   *
   * @minItems 1
   * @maxItems 64
   */
  steps?: [CaseStep, ...CaseStep[]];
  /**
   * 兼容历史独立清理任务；新 case 的清理使用同任务末尾步骤。
   */
  purpose?: 'verification' | 'cleanup';
  /**
   * 清理任务关联的原任务身份。
   */
  parentTaskId?: string;
  /**
   * 仅保留历史任务的互斥键用于读取；新任务禁止提交，当前调度不使用资源锁。
   */
  resourceKey?: string;
  /**
   * 历史独立清理的冻结预算；新 case 不再设置此字段，所有步骤共享 budget。
   */
  cleanupBudget?: {
    timeoutMs: number;
    maxActions: number;
  };
  /**
   * 同一任务末尾的业务清理步骤身份；存在时不再创建独立清理任务。
   *
   * @maxItems 32
   */
  cleanupStepIds?: string[];
  /**
   * 按步骤独立冻结的预算；缺失时保留旧任务总预算语义。清理共享独立额度。
   */
  stepBudget?: {
    version: 1;
    /**
     * @minItems 1
     */
    steps: [
      {
        timeoutMs: number;
        maxActions: number;
        maxModelCalls: number;
        stepId: string;
      },
      ...{
        timeoutMs: number;
        maxActions: number;
        maxModelCalls: number;
        stepId: string;
      }[],
    ];
    cleanup: {
      timeoutMs: number;
      maxActions: number;
      maxModelCalls: number;
    };
    /**
     * 每步结束允许在途操作完成和持久化的额外时间，不可用于派发新操作。
     */
    settleMs: number;
  };
  sessionPlan?: SessionPlan;
  /**
   * 一个执行拥有一个 profile，各 setup 分组独占标签页；旧任务缺省时保持串行语义。
   */
  profilePlan?: {
    version: 1;
    maxConcurrency: number;
    /**
     * @minItems 1
     * @maxItems 32
     */
    groups: [
      {
        id: string;
        /**
         * @minItems 1
         * @maxItems 32
         */
        stepIds: [string, ...string[]];
      },
      ...{
        id: string;
        /**
         * @minItems 1
         * @maxItems 32
         */
        stepIds: [string, ...string[]];
      }[],
    ];
    /**
     * 新任务首个 setup 核实共享环境后才启动其他组；缺省保持历史并发行为。
     */
    environmentGateStepId?: string;
  };
  executionPlan?: {
    version: 1;
    environment: {
      mode: 'guest' | 'configured';
      source: 'explicit' | 'inferred' | 'default';
      /**
       * @maxItems 64
       */
      basis: string[];
      /**
       * 版本 2 默认使用节点模板，版本 1 保留历史空白/自动账号语义。
       */
      resolverVersion: 1 | 2;
    };
    evidenceKinds: ('DOM' | 'SCREENSHOT' | 'NETWORK' | 'TRACE' | 'RUNTIME')[];
    /**
     * 本步骤必须具备的实际节点能力；文本推导只补充已识别的需求。
     */
    requiredCapabilities?: ('runtimeEvidenceV1' | 'networkDetailsV1' | 'focusRecoveryV1')[];
  };
  rerunSession?: SessionRequest1;
  /**
   * 通用浏览器任务；缺省保持历史验证任务语义。
   */
  taskKind?: 'browser';
};
export type CaseStep = {
  /**
   * 步骤身份；省略时按原始数组位置生成，排序不改变身份。
   */
  stepId?: string;
  /**
   * setup 建立前置条件，verification 执行并验收业务结果。
   */
  type: 'setup' | 'verification';
  /**
   * 本步操作的 HTTP(S) 入口；纯等待保持当前页面。
   */
  url: string;
  /**
   * 升序执行；同值按原数组顺序串行。
   */
  exec_order: number;
  /**
   * 上游定义的本步操作说明，不作为自由重排任务的授权。
   */
  description: string;
  /**
   * 操作约束，保持原文；自然语言不等同于程序强制校验。
   *
   * @maxItems 32
   */
  policy: string[];
  /**
   * 本步骤的逐项验收标准；setup 可为空。
   *
   * @maxItems 32
   */
  expected: string[];
  /**
   * 显式等待，不调用模型；持续占用会话并计入任务预算。
   */
  wait?: {
    durationMs: number;
  };
  /**
   * @maxItems 32
   */
  preconditions?: IdentityCheck[];
  /**
   * @maxItems 32
   */
  policyChecks?: {
    id: string;
    description: string;
    policyIndex: number;
    method: 'networkResponse' | 'renderedContent';
    path?: string;
    text?: string;
    statusMin?: number;
    statusMax?: number;
  }[];
  /**
   * 本步骤必须具备的实际节点能力；文本推导只补充已识别的需求。
   */
  requiredCapabilities?: ('runtimeEvidenceV1' | 'networkDetailsV1' | 'focusRecoveryV1')[];
} & {
  /**
   * 步骤身份；省略时按原始数组位置生成，排序不改变身份。
   */
  stepId?: string;
  /**
   * setup 建立前置条件，verification 执行并验收业务结果。
   */
  type: 'setup' | 'verification';
  /**
   * 本步操作的 HTTP(S) 入口；纯等待保持当前页面。
   */
  url: string;
  /**
   * 升序执行；同值按原数组顺序串行。
   */
  exec_order: number;
  /**
   * 上游定义的本步操作说明，不作为自由重排任务的授权。
   */
  description: string;
  /**
   * 操作约束，保持原文；自然语言不等同于程序强制校验。
   *
   * @maxItems 32
   */
  policy: string[];
  /**
   * 本步骤的逐项验收标准；setup 可为空。
   *
   * @maxItems 32
   */
  expected: string[];
  /**
   * 显式等待，不调用模型；持续占用会话并计入任务预算。
   */
  wait?: {
    durationMs: number;
  };
  /**
   * @maxItems 32
   */
  preconditions?: IdentityCheck[];
  /**
   * @maxItems 32
   */
  policyChecks?: {
    id: string;
    description: string;
    policyIndex: number;
    method: 'networkResponse' | 'renderedContent';
    path?: string;
    text?: string;
    statusMin?: number;
    statusMax?: number;
  }[];
  /**
   * 本步骤必须具备的实际节点能力；文本推导只补充已识别的需求。
   */
  requiredCapabilities?: ('runtimeEvidenceV1' | 'networkDetailsV1' | 'focusRecoveryV1')[];
} & {
  /**
   * 步骤身份；省略时按原始数组位置生成，排序不改变身份。
   */
  stepId?: string;
  /**
   * setup 建立前置条件，verification 执行并验收业务结果。
   */
  type: 'setup' | 'verification';
  /**
   * 本步操作的 HTTP(S) 入口；纯等待保持当前页面。
   */
  url: string;
  /**
   * 升序执行；同值按原数组顺序串行。
   */
  exec_order: number;
  /**
   * 上游定义的本步操作说明，不作为自由重排任务的授权。
   */
  description: string;
  /**
   * 操作约束，保持原文；自然语言不等同于程序强制校验。
   *
   * @maxItems 32
   */
  policy: string[];
  /**
   * 本步骤的逐项验收标准；setup 可为空。
   *
   * @maxItems 32
   */
  expected: string[];
  /**
   * 显式等待，不调用模型；持续占用会话并计入任务预算。
   */
  wait?: {
    durationMs: number;
  };
  /**
   * @maxItems 32
   */
  preconditions?: IdentityCheck[];
  /**
   * @maxItems 32
   */
  policyChecks?: {
    id: string;
    description: string;
    policyIndex: number;
    method: 'networkResponse' | 'renderedContent';
    path?: string;
    text?: string;
    statusMin?: number;
    statusMax?: number;
  }[];
  /**
   * 本步骤必须具备的实际节点能力；文本推导只补充已识别的需求。
   */
  requiredCapabilities?: ('runtimeEvidenceV1' | 'networkDetailsV1' | 'focusRecoveryV1')[];
} & {
  /**
   * 步骤身份；省略时按原始数组位置生成，排序不改变身份。
   */
  stepId?: string;
  /**
   * setup 建立前置条件，verification 执行并验收业务结果。
   */
  type: 'setup' | 'verification';
  /**
   * 本步操作的 HTTP(S) 入口；纯等待保持当前页面。
   */
  url: string;
  /**
   * 升序执行；同值按原数组顺序串行。
   */
  exec_order: number;
  /**
   * 上游定义的本步操作说明，不作为自由重排任务的授权。
   */
  description: string;
  /**
   * 操作约束，保持原文；自然语言不等同于程序强制校验。
   *
   * @maxItems 32
   */
  policy: string[];
  /**
   * 本步骤的逐项验收标准；setup 可为空。
   *
   * @maxItems 32
   */
  expected: string[];
  /**
   * 显式等待，不调用模型；持续占用会话并计入任务预算。
   */
  wait?: {
    durationMs: number;
  };
  /**
   * @maxItems 32
   */
  preconditions?: IdentityCheck[];
  /**
   * @maxItems 32
   */
  policyChecks?: {
    id: string;
    description: string;
    policyIndex: number;
    method: 'networkResponse' | 'renderedContent';
    path?: string;
    text?: string;
    statusMin?: number;
    statusMax?: number;
  }[];
  /**
   * 本步骤必须具备的实际节点能力；文本推导只补充已识别的需求。
   */
  requiredCapabilities?: ('runtimeEvidenceV1' | 'networkDetailsV1' | 'focusRecoveryV1')[];
};
/**
 * 显式前置条件；文本检查使用完整观察，人工条件只能由当前会话的人工确认满足。
 */
export type IdentityCheck = {
  id: string;
  description: string;
  method: 'text' | 'absent' | 'manual';
  value?: string;
};
/**
 * 省略或 auto 时按 case 自动准备身份，优先 DevPass、无账号则人工介入；可显式约束身份，禁止携带密码或 Cookie。
 */
export type SessionRequest = {
  mode: 'auto' | 'guest' | 'manual' | 'external';
  /**
   * @maxItems 32
   */
  requirements?: IdentityCheck[];
  external?: ExternalAccountSelector;
  /**
   * 本次会话是否偏好减少动画；省略时新执行默认 true，动画验收可显式设为 false。历史缺失字段不代表已启用。
   */
  reducedMotion?: boolean;
};
/**
 * 执行会话快照。新任务仅生成 guest/manual/external；旧本地身份字段仅用于读取历史快照，提交与执行入口拒绝使用。
 */
export type SessionPlan = {
  version: 1;
  mode: 'guest' | 'manual' | 'identity' | 'pool' | 'external';
  /**
   * @maxItems 256
   */
  candidates: {
    id: string;
    label: string;
    accountKey: string;
    nodeId?: string;
    stateId?: string;
    /**
     * @maxItems 16
     */
    origins:
      | []
      | [string]
      | [string, string]
      | [string, string, string]
      | [string, string, string, string]
      | [string, string, string, string, string]
      | [string, string, string, string, string, string]
      | [string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string, string]
      | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      | [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ];
    /**
     * @maxItems 32
     */
    checks: IdentityCheck[];
    loginRef?: string;
    maxConcurrent: number;
    libraryVersion?: string;
    description?: string;
    identityType?: string;
    url?: string;
  }[];
  /**
   * @maxItems 32
   */
  requirements: IdentityCheck[];
  preparationMs: number;
  /**
   * 仅兼容历史本地身份快照，新执行不允许启用。
   */
  library?: boolean;
  selection?: 'pending' | 'selected' | 'human';
  selectionReason?: string;
  external?: {
    selector: ExternalAccountSelector;
    origin: string;
    durationSeconds: number;
  };
  /**
   * 本次运行自动判断的登录需求及转人工原因，不改写历史快照。
   */
  automatic?: {
    /**
     * 根据原始操作与身份条件冻结的登录需求；访客要求优先。
     */
    loginRequired: boolean;
    /**
     * 本次运行转入人工准备的公开原因码，不含凭据或供应方原始错误。
     */
    fallbackReason?: string;
  };
  /**
   * 本次会话是否偏好减少动画；省略时新执行默认 true，动画验收可显式设为 false。历史缺失字段不代表已启用。
   */
  reducedMotion?: boolean;
  /**
   * 新运行冻结的浏览器初始来源；缺省保持历史空白语义。访客与外部账号仅允许 empty。
   */
  profileSource?: 'empty' | 'node-default';
};
/**
 * 省略或 auto 时按 case 自动准备身份，优先 DevPass、无账号则人工介入；可显式约束身份，禁止携带密码或 Cookie。
 */
export type SessionRequest1 = {
  mode: 'auto' | 'guest' | 'manual' | 'external';
  /**
   * @maxItems 32
   */
  requirements?: IdentityCheck[];
  external?: ExternalAccountSelector;
  /**
   * 本次会话是否偏好减少动画；省略时新执行默认 true，动画验收可显式设为 false。历史缺失字段不代表已启用。
   */
  reducedMotion?: boolean;
};
/**
 * 平台内部执行报告；外部读取 CaseResult。结构有效不代表业务判断已被独立证实。
 */
export type VerificationReport = {
  protocolVersion: '0.1';
  taskId: string;
  lifecycle: 'COMPLETED' | 'CANCELLED' | 'TIMED_OUT';
  executionDisposition: 'EXECUTED' | 'BLOCKED' | 'ERROR';
  verdict: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | null;
  summary: string;
  criteria: {
    criterionId: string;
    verdict: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'SKIPPED';
    summary: string;
    evidenceRefs: string[];
  }[];
  artifacts: {
    id: string;
    kind: 'DOM' | 'SCREENSHOT' | 'NETWORK' | 'TRACE' | 'RUNTIME';
    uri: string;
    sha256: string;
  }[];
  executionDetails?: ExecutionDetails;
  /**
   * 结构化任务的逐步执行事实；异常终止仍保留已完成验收。
   *
   * @minItems 1
   * @maxItems 64
   */
  steps?: [StepResult, ...StepResult[]];
  /**
   * 仅由人工处理服务写入；执行器不能伪造人为无法执行的结论。
   */
  humanDecision?: {
    outcome: 'UNEXECUTABLE';
    reason: string;
    decidedAt: string;
  };
  /**
   * 浏览器任务的交付正文和证据，不作为验证通过结论。
   */
  browserResult?: {
    outcome: 'COMPLETED' | 'INCOMPLETE';
    output: string;
    evidenceRefs: string[];
  };
  /**
   * @deprecated
   * 仅兼容退役 external 运行的历史报告；当前执行器不再生成此字段。
   */
  executor?: {
    kind: 'external';
    judgmentSource: 'external_agent';
    usageSource: 'unavailable';
    decisionCalls: number;
    modelCalls: null;
    promptTokens: null;
    completionTokens: null;
  };
};

/**
 * 管理员任务详情；不返回执行令牌、凭据摘要或节点授权。
 */
export interface TaskDetail {
  id: string;
  definition: VerificationTask;
  state: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'TIMED_OUT' | 'ERROR';
  deadline_at: string;
  report: VerificationReport | null;
  error: {
    [k: string]: unknown;
  } | null;
  created_at: string;
  finished_at: string | null;
  /**
   * Items: 执行终态与浏览器关闭确认独立；不得据任务完成推断容量已释放。
   */
  executions: {
    id: string;
    worker_id: string;
    state: 'STARTING' | 'RUNNING' | 'STOPPING' | 'FINISHED';
    lease_expires_at: string;
    session_id: string;
    node_id: string;
    session_state: 'OPENING' | 'ACTIVE' | 'CLOSING' | 'CLOSED' | 'QUARANTINED';
    closure_verified: boolean;
    action_count: number;
    control_mode: 'AUTO' | 'REQUESTED' | 'HUMAN';
    /**
     * 人工控制代次；旧页面和旧模型决定不能操作恢复后的会话。
     */
    control_revision: number;
    control_reason: string | null;
    /**
     * 分配会话时冻结的节点版本，升级后保留原值；历史记录未知时为 null。
     */
    node_runtime?: NodeRuntime | null;
    /**
     * 节点持久化的会话关闭触发原因；旧节点没有证据时为 null。
     */
    close_reason?: string | null;
  }[];
  /**
   * 证据内容已按保留策略清理；报告结论和身份仍保留。
   */
  archived_at: string | null;
  stepResults?: null | StepResult[];
  businessCleanup?: null | {
    taskId: string;
    status: 'PENDING' | 'QUEUED' | 'SKIPPED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'TIMED_OUT' | 'ERROR';
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
  identity?: {
    mode: 'guest' | 'manual' | 'identity' | 'pool' | 'external';
    identityRef: string | null;
    label: string | null;
    leaseState: 'NOT_REQUIRED' | 'WAITING' | 'OCCUPIED' | 'RELEASED';
    preparation: {
      status: 'NOT_REQUESTED' | 'PENDING' | 'READY' | 'NEEDS_HUMAN' | 'ERROR' | 'LOADED';
      source: 'snapshot' | 'cookies' | 'password' | 'none' | 'profile';
      reasonCode: string | null;
      durationMs: number | null;
    };
    humanRequests: number;
    humanCompleted: number;
    humanReasons: {
      reason: string;
      count: number;
    }[];
    external?: {
      requestId: string;
      leaseId: string | null;
      accountId: string | null;
      materialVersion: string | null;
      expiresAt: string | null;
      state: string;
      reason: string | null;
    };
  };
  executionOutcome?: ExecutionOutcome;
}
/**
 * case 入口保存的原始业务定义，用于幂等重提和隔离公开读取；普通内部任务省略。
 */
export interface VerificationCase {
  /**
   * 本次验证的幂等身份；再次执行使用新的身份。
   */
  caseId: string;
  /**
   * 完整任务描述：验证目标、业务背景、涉及对象及必要约束。
   */
  description: string;
  /**
   * 本次验证的 HTTP(S) 入口地址，由调用方明确提供，必须能从执行节点访问。
   */
  url: string;
  /**
   * 可选的必要业务步骤；不要求提供选择器或固定页面点击路径。
   *
   * @minItems 1
   * @maxItems 32
   */
  steps?: [string, ...string[]];
  /**
   * 上层定义的完整业务验收项；缺少标准时不由平台自行补写。
   *
   * @minItems 1
   */
  acceptanceCriteria: [
    {
      /**
       * 任务内唯一的验收项身份，结果通过 criterionId 对应。
       */
      id: string;
      /**
       * 检查对象、范围及必要观察时机。
       */
      description: string;
      /**
       * 可以据证据判断的预期业务结果。
       */
      expectedResult: string;
    },
    ...{
      /**
       * 任务内唯一的验收项身份，结果通过 criterionId 对应。
       */
      id: string;
      /**
       * 检查对象、范围及必要观察时机。
       */
      description: string;
      /**
       * 可以据证据判断的预期业务结果。
       */
      expectedResult: string;
    }[],
  ];
}
/**
 * v2 原始业务定义，冻结用于幂等比较。
 */
export interface VerificationCaseV2 {
  /**
   * 本次任务的幂等身份；重跑必须使用新的身份。
   */
  caseId: string;
  /**
   * 业务平台标签，不用于自动选择登录账号。
   */
  platform: string;
  /**
   * 任务所属站点的 HTTP(S) 入口。
   */
  entry: string;
  /**
   * 任务背景，省略时由平台生成不含额外验收标准的概述。
   */
  description?: string;
  /**
   * 上游定义的操作与验收步骤；服务端补齐身份后稳定排序。
   *
   * @minItems 1
   * @maxItems 32
   */
  steps: [CaseStep, ...CaseStep[]];
  /**
   * 在同一任务和浏览器会话末尾执行的业务清理操作，不是浏览器资源回收。
   *
   * @maxItems 32
   */
  cleanup: {
    stepId?: string;
    url: string;
    /**
     * 升序执行；同值按原数组顺序串行。
     */
    exec_order: number;
    description: string;
    /**
     * @maxItems 32
     */
    policy?: string[];
    /**
     * @maxItems 32
     */
    expected?: string[];
    /**
     * @maxItems 32
     */
    policyChecks?: {
      id: string;
      description: string;
      policyIndex: number;
      method: 'networkResponse' | 'renderedContent';
      path?: string;
      text?: string;
      statusMin?: number;
      statusMax?: number;
    }[];
  }[];
  session?: SessionRequest;
}
/**
 * 外部账号的无秘密选择条件；地址和密钥仅由部署配置提供。
 */
export interface ExternalAccountSelector {
  provider: string;
  platform: string;
  poolId?: string;
  accountId?: string;
  /**
   * @maxItems 32
   */
  roles?: string[];
}
export interface ExecutionDetails {
  /**
   * 机器可读的执行结束原因；正常验收可为 null。
   */
  reasonCode: string | null;
  /**
   * 配置的模型名称，不包含 API 地址或凭据。
   */
  model: string;
  /**
   * 实际发起的模型请求次数。
   */
  modelCalls: number;
  /**
   * 提交的浏览器写动作数，包含初次导航。
   */
  actions: number;
  /**
   * 从领取到生成报告的耗时。
   */
  elapsedMs: number;
  /**
   * 按提交顺序记录命令，HTTP 重送不添加新身份。
   *
   * Items: 可追溯到控制面结果的命令身份。
   */
  commandIds: string[];
  /**
   * 已解析工具回复中的输入 token 计数；缺失 usage 的调用不计入。
   */
  promptTokens: number;
  /**
   * 已解析工具回复中的输出 token 计数；不能作为完整账单。
   */
  completionTokens: number;
  /**
   * 按实际提供者分别累计请求与已返回的用量；不是账单。
   */
  modelUsage?: {
    model: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
  }[];
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
/**
 * 节点进程上报的编译身份；用于排查部署版本，不作为授权或能力判断依据。
 */
export interface NodeRuntime {
  /**
   * 完整 release 标签；开发构建带 dev 后缀，不冒充正式安装版本。
   */
  version: string;
  /**
   * 发布源码的完整提交 SHA；本地未注入时为 null。
   */
  sourceCommit: string | null;
  /**
   * 节点启动时核实的 agent-browser 固定版本。
   */
  engineVersion: string;
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
