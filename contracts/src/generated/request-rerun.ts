/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 仅为此 case 的新运行替换会话身份；省略时沿用来源，历史本地身份须显式重新选择。
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
 * 显式前置条件；文本检查使用完整观察，人工条件只能由当前会话的人工确认满足。
 */
export type IdentityCheck = {
  id: string;
  description: string;
  method: 'text' | 'absent' | 'manual';
  value?: string;
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

export interface RequestRerun {
  /**
   * 可选的旧版新请求身份；省略时在原请求内新增运行，重试沿用 caseIds。
   */
  requestId?: string;
  /**
   * 原请求内待重跑的 case 与新运行映射；可选一个或全部成员，服务端原子提交。指定新 requestId 时必须覆盖全部成员。
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
      session?: SessionRequest;
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
        session?: SessionRequest;
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
      session?: SessionRequest;
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
        session?: SessionRequest;
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
