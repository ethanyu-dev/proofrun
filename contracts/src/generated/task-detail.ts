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
     * 是否允许人工辅助；等待计入原任务预算，人工不能修改验收标准。
     */
    allowIntervention?: boolean;
    auth?: {
      /**
       * 节点私有登录状态名称，不是路径。
       */
      stateId: string;
      /**
       * 是否要求载入已有状态；首次人工登录时设为 false。
       */
      restore: boolean;
      /**
       * 登录状态所属节点，调度固定到此节点。
       */
      nodeId: string;
    };
    /**
     * 是否按环境和目标站点自动复用节点登录快照；未指定时跟随 allowIntervention。显式 auth 配置优先。
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
    evidenceKinds: ['DOM' | 'SCREENSHOT' | 'NETWORK' | 'TRACE', ...('DOM' | 'SCREENSHOT' | 'NETWORK' | 'TRACE')[]];
    /**
     * 结构化任务中所属步骤身份。
     */
    stepId?: string;
  }[];
  budget: {
    timeoutMs: number;
    maxActions: number;
  };
  /**
   * 控制面原子创建的双组对比身份；两组业务目标与预算一致，分别占用独立会话。
   */
  comparison?: {
    id: string;
    arm: 'llm' | 'jev';
    sourceTaskId: string;
  };
  /**
   * 执行方式：parallel 原子创建纯 LLM 与 LLM + JEV 两组；llm、jev 各运行一个任务。省略时兼容旧任务，按 comparison.arm 或纯 LLM 执行。
   */
  executionMode?: 'parallel' | 'llm' | 'jev';
  caseV2Definition?: VerificationCaseV2;
  /**
   * 服务端规范化的串行步骤；每项均有稳定 stepId。
   *
   * @minItems 1
   * @maxItems 32
   */
  steps?: [CaseStep, ...CaseStep[]];
  /**
   * 清理是独立内部任务，不扩展公开步骤类型。
   */
  purpose?: 'verification' | 'cleanup';
  /**
   * 清理任务关联的原任务身份。
   */
  parentTaskId?: string;
  /**
   * 平台生成的任务及业务上下文互斥键；主任务与其清理共享，不同 caseId 独立。
   */
  resourceKey?: string;
  /**
   * v2 首次提交冻结的独立清理预算；历史任务缺失时沿用主任务预算。
   */
  cleanupBudget?: {
    timeoutMs: number;
    maxActions: number;
  };
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
    kind: 'DOM' | 'SCREENSHOT' | 'NETWORK' | 'TRACE';
    uri: string;
    sha256: string;
  }[];
  executionDetails?: ExecutionDetails;
  /**
   * 结构化任务的逐步执行事实；异常终止仍保留已完成验收。
   *
   * @minItems 1
   * @maxItems 32
   */
  steps?: [StepResult, ...StepResult[]];
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
   * 结束后独立执行的业务清理操作，不是浏览器资源回收。
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
  }[];
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
    | 'NODE_ROTATING';
  message: string;
}
