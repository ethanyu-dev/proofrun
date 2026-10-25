/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

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
