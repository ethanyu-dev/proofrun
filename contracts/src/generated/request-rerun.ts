/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

export interface RequestRerun {
  /**
   * 逻辑提交的稳定身份；重试沿用，重跑使用新身份。
   */
  requestId: string;
  /**
   * 完整旧新身份映射，由服务端校验覆盖和唯一性。
   *
   * @minItems 1
   * @maxItems 32
   */
  caseIds: [
    {
      /**
       * 整请求重跑对应的原 case；普通提交为 null。
       */
      sourceCaseId: string;
      /**
       * 全局 case 幂等身份，不改为请求内局部身份。
       */
      caseId: string;
    },
    ...{
      /**
       * 整请求重跑对应的原 case；普通提交为 null。
       */
      sourceCaseId: string;
      /**
       * 全局 case 幂等身份，不改为请求内局部身份。
       */
      caseId: string;
    }[],
  ];
  /**
   * current 使用当前预算；original 沿用来源预算。
   */
  budgetMode?: 'current' | 'original';
  /**
   * 只增加时间下限，不改变动作与模型额度。
   */
  timeBudget?: {
    /**
     * 每个业务步骤的时间下限，毫秒；不缩短原等待。
     */
    stepTimeoutMs?: number;
    /**
     * 整段清理的时间下限，毫秒。
     */
    cleanupTimeoutMs?: number;
  };
}
