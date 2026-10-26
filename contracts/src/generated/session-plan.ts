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
  /**
   * 本次运行自动判断的登录需求及转人工原因，不改写历史快照。
   */
  automatic?: {
    /**
     * 根据原始操作与身份条件冻结的登录需求；访客要求优先。
     */
    loginRequired: boolean;
    /**
     * 本次运行转入人工准备的公开原因码，不含凭据或供应方原始错误。
     */
    fallbackReason?: string;
  };
  /**
   * 本次会话是否偏好减少动画；省略时新执行默认 true，动画验收可显式设为 false。历史缺失字段不代表已启用。
   */
  reducedMotion?: boolean;
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
