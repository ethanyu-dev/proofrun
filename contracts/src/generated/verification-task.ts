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
   * 平台生成的任务及业务上下文互斥键；主任务与其清理共享，不同 caseId 独立。
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
  }[];
}
