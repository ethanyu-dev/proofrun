/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

export interface RequestRerun {
  /**
   * 逻辑提交的稳定身份；重试沿用，重跑使用新身份。
   */
  requestId: string;
  /**
   * 完整 case 与新运行映射，由服务端原子提交。
   *
   * @minItems 1
   * @maxItems 32
   */
  caseIds: [
    (
      | {
          runId: unknown;
          [k: string]: unknown;
        }
      | {
          caseId: unknown;
          [k: string]: unknown;
        }
    ) & {
      /**
       * 整请求重跑对应的原 case；普通提交为 null。
       */
      sourceCaseId: string;
      /**
       * 旧客户端兼容字段，仅作为运行幂等键，不再创建新 case。
       */
      caseId?: string;
      /**
       * 新运行幂等键；重试保持不变，caseId 不改变。
       */
      runId?: string;
    } & (
        | {
            runId: unknown;
            [k: string]: unknown;
          }
        | {
            caseId: unknown;
            [k: string]: unknown;
          }
      ) & {
        /**
         * 整请求重跑对应的原 case；普通提交为 null。
         */
        sourceCaseId: string;
        /**
         * 旧客户端兼容字段，仅作为运行幂等键，不再创建新 case。
         */
        caseId?: string;
        /**
         * 新运行幂等键；重试保持不变，caseId 不改变。
         */
        runId?: string;
      },
    ...((
      | {
          runId: unknown;
          [k: string]: unknown;
        }
      | {
          caseId: unknown;
          [k: string]: unknown;
        }
    ) & {
      /**
       * 整请求重跑对应的原 case；普通提交为 null。
       */
      sourceCaseId: string;
      /**
       * 旧客户端兼容字段，仅作为运行幂等键，不再创建新 case。
       */
      caseId?: string;
      /**
       * 新运行幂等键；重试保持不变，caseId 不改变。
       */
      runId?: string;
    } & (
        | {
            runId: unknown;
            [k: string]: unknown;
          }
        | {
            caseId: unknown;
            [k: string]: unknown;
          }
      ) & {
        /**
         * 整请求重跑对应的原 case；普通提交为 null。
         */
        sourceCaseId: string;
        /**
         * 旧客户端兼容字段，仅作为运行幂等键，不再创建新 case。
         */
        caseId?: string;
        /**
         * 新运行幂等键；重试保持不变，caseId 不改变。
         */
        runId?: string;
      })[],
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
