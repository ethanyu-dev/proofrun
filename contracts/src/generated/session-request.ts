/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

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
