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
