/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 上层提交的不可变定义。
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

export interface ExecutionGrant {
  /**
   * 执行身份。
   */
  id: string;
  task: VerificationTask;
  /**
   * 仅本次执行可用的权限，不进入模型上下文。
   */
  leaseToken: string;
  /**
   * 当前 worker 权限期限。
   */
  leaseExpiresAt: string;
  /**
   * 初始执行截止时间；人工暂停及恢复后以控制面视图为准。
   */
  taskDeadlineAt: string;
  /**
   * 平台预留的会话。
   */
  sessionId: string;
  /**
   * 平台选中的节点。
   */
  nodeId: string;
  state: 'STARTING';
  /**
   * 存在时必须使用内部运行时接口；省略为旧 worker 驱动路径。
   */
  runtimeVersion?: 1;
  /**
   * 由调度器根据持久化关联生成，不接受任务输入自行开启故障注入。
   */
  benchmark?: {
    runId: string;
    caseId: string;
  };
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
