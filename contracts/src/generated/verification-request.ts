/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

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
 * 只支持访客、当前会话人工登录和 DevPass 外部账号；禁止携带密码或 Cookie。
 */
export type SessionRequest = {
  mode: 'guest' | 'manual' | 'external';
  /**
   * @maxItems 32
   */
  requirements?: IdentityCheck[];
  external?: ExternalAccountSelector;
};
/**
 * 外部账号的无秘密选择条件；地址和密钥仅由部署配置提供。
 */
export type ExternalAccountSelector = (
  | {
      poolId: string;
      [k: string]: unknown;
    }
  | {
      accountId: string;
      [k: string]: unknown;
    }
) & {
  provider: string;
  platform: string;
  poolId?: string;
  accountId?: string;
  /**
   * @maxItems 32
   */
  roles?: string[];
};

export interface VerificationRequest {
  /**
   * 逻辑提交的稳定身份；重试沿用，重跑使用新身份。
   */
  requestId: string;
  /**
   * 展示标题首次接收后冻结，不生成或改写验证目标。
   */
  title?: string;
  /**
   * 首次接收冻结的成员与顺序，不按当前筛选截断。
   *
   * @minItems 1
   * @maxItems 32
   */
  cases: [VerificationCaseV2, ...VerificationCaseV2[]];
}
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
