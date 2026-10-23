/** 从 JSON Schema 自动生成；请修改契约源文件后重新生成。 */

export type ReleaseAccountOutput =
  | {
      schema_version: '1';
      status: 'released';
      lease_id: string;
      released_at: string;
    }
  | {
      schema_version: '1';
      status: 'release_pending';
      lease_id: string;
      released_at: null;
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
