/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 上层定义的单次验证 case；环境、登录态、取证方式和预算由平台配置。
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
