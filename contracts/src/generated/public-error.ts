/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

export interface PublicError {
  code: string;
  message: string;
  retryable: boolean;
  /**
   * @maxItems 100
   */
  details?: {
    path: string;
    message: string;
  }[];
}
