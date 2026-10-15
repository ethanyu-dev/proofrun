/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

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
 * 平台冻结的非敏感身份候选；分配在领取事务内完成，凭据只在节点解析。
 */
export interface SessionPlan {
  version: 1;
  mode: 'guest' | 'manual' | 'identity' | 'pool';
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
   * 使用页面身份库和完整 profile；选择由独立身份 Agent 完成。
   */
  library?: boolean;
  selection?: 'pending' | 'selected' | 'human';
  selectionReason?: string;
}
