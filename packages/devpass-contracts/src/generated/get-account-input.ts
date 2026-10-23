/** 从 JSON Schema 自动生成；请修改契约源文件后重新生成。 */

/**
 * 请求一次固定期限的账号使用额度。
 */
export interface GetAccountInput {
  /**
   * 调用方范围内的业务幂等键。
   */
  request_id: string;
  /**
   * 目标平台的稳定标识。
   */
  platform: string;
  /**
   * 凭据适用的精确源，不含业务路径。
   */
  origin: string;
  /**
   * @maxItems 32
   */
  role_description?: string[];
  /**
   * @minItems 1
   * @maxItems 3
   */
  accepted_material_types: [
    'http_bearer' | 'browser_cookies' | 'browser_storage',
    ...('http_bearer' | 'browser_cookies' | 'browser_storage')[],
  ];
  duration_seconds?: number;
  account_id?: string;
  pool_id?: string;
}
