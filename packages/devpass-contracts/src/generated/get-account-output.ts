/** 从 JSON Schema 自动生成；请修改契约源文件后重新生成。 */

export type GetAccountOutput =
  | {
      schema_version: '1';
      status: 'allocated';
      /**
       * 冻结在本次租约中的账号描述，原始凭据仅存在于密文。
       */
      account: {
        id: string;
        platform: string;
        /**
         * 凭据适用的精确源，不含业务路径。
         */
        origin: string;
        /**
         * @maxItems 32
         */
        role_description: string[];
        note: string;
        hitl_case: string;
        concurrency: number;
        material: {
          type: 'http_bearer' | 'browser_cookies' | 'browser_storage';
          version: string;
          expires_at: string | null;
          delivery: {
            format: 'jwe';
            recipient_key_id: string;
            /**
             * 仅可信运行环境可以解密。
             */
            ciphertext: string;
          };
        };
      };
      lease: {
        id: string;
        issued_at: string;
        expires_at: string;
      };
    }
  | {
      schema_version: '1';
      status: 'unavailable';
      reason:
        | 'NO_MATCH'
        | 'CAPACITY_EXHAUSTED'
        | 'ACCOUNT_NOT_READY'
        | 'MATERIAL_TYPE_UNSUPPORTED'
        | 'MATERIAL_EXPIRED'
        | 'MATERIAL_EXPIRES_TOO_SOON';
      message: string;
      retry_after_seconds: number | null;
    }
  | {
      schema_version: '1';
      status: 'error';
      error: {
        code:
          | 'FORBIDDEN'
          | 'IDEMPOTENCY_CONFLICT'
          | 'DURATION_NOT_ALLOWED'
          | 'RECIPIENT_KEY_UNAVAILABLE'
          | 'LEASE_NOT_FOUND'
          | 'LEASE_EXPIRED'
          | 'LEASE_CLOSED'
          | 'MATERIAL_REVOKED'
          | 'RELEASE_CONFLICT'
          | 'RATE_LIMITED'
          | 'TEMPORARY_UNAVAILABLE'
          | 'INVALID_ARGUMENT';
        message: string;
        retryable: boolean;
        retry_after_seconds: number | null;
      };
    };
