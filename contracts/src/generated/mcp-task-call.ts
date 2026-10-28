/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 两套任务级 MCP 与公共 HTTP 共用的第一阶段输入契约；未知字段及外部控制显式拒绝。
 */
export type McpTaskCall =
  | {
      name: 'browser_get_capabilities';
      arguments: {
        url?: string;
        runId?: string;
      };
    }
  | {
      name: 'browser_task_submit';
      arguments: {
        taskKey: string;
        url: string;
        objective: string;
      };
    }
  | {
      name: 'browser_task_get';
      arguments: {
        runId: string;
        view?: 'summary' | 'full';
        cursor?: string;
        limit?: number;
      };
    }
  | {
      name: 'browser_task_cancel';
      arguments: {
        runId: string;
        operationId: string;
        reason?: string;
      };
    }
  | {
      name: 'browser_evidence_read';
      arguments: {
        runId: string;
        evidenceId: string;
        representation?: 'metadata' | 'content';
        offset?: number;
        limit?: number;
      };
    }
  | {
      name: 'browser_operation_get';
      arguments: {
        operationId: string;
      };
    }
  | {
      name: 'verification_get_capabilities';
      arguments: {
        entry?: string;
        executor?: {
          kind: 'builtin' | 'external';
        };
      };
    }
  | {
      name: 'verification_validate_cases';
      arguments: {
        requestId: string;
        title?: string;
        /**
         * @minItems 1
         * @maxItems 32
         */
        cases: [VerificationCaseV2, ...VerificationCaseV2[]];
        executor?: {
          kind: 'builtin' | 'external';
        };
      };
    }
  | {
      name: 'verification_submit_cases';
      arguments: {
        requestId: string;
        title?: string;
        /**
         * @minItems 1
         * @maxItems 32
         */
        cases: [VerificationCaseV2, ...VerificationCaseV2[]];
        executor?: {
          kind: 'builtin' | 'external';
        };
      };
    }
  | {
      name: 'verification_get_request';
      arguments: {
        requestId: string;
        view?: 'summary' | 'report';
        cursor?: string;
        limit?: number;
      };
    }
  | {
      name: 'verification_get_run';
      arguments: {
        runId: string;
        view?: 'summary' | 'full';
        cursor?: string;
        limit?: number;
      };
    }
  | {
      name: 'verification_cancel_run';
      arguments: {
        runId: string;
        operationId: string;
        reason?: string;
      };
    }
  | {
      name: 'verification_rerun_cases';
      arguments: {
        requestId: string;
        operationId: string;
        expectedRequestRevision: string;
        /**
         * @minItems 1
         * @maxItems 32
         */
        items: [
          {
            caseId: string;
            sourceRunId: string;
            runKey: string;
          },
          ...{
            caseId: string;
            sourceRunId: string;
            runKey: string;
          }[],
        ];
        executor?: {
          kind: 'builtin';
        };
        budgetMode?: 'current' | 'original';
        timeBudget?: {
          stepTimeoutMs?: number;
          cleanupTimeoutMs?: number;
        };
      };
    }
  | {
      name: 'verification_read_evidence';
      arguments: {
        runId: string;
        evidenceId: string;
        representation?: 'metadata' | 'content';
        offset?: number;
        limit?: number;
      };
    }
  | {
      name: 'verification_operation_get';
      arguments: {
        operationId: string;
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
} & {
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
