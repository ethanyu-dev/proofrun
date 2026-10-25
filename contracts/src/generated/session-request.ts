/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 省略或 auto 时按 case 自动准备身份，优先 DevPass、无账号则人工介入；可显式约束身份，禁止携带密码或 Cookie。
 */
export type SessionRequest = {
  mode: 'auto' | 'guest' | 'manual' | 'external';
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
