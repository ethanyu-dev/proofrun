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
