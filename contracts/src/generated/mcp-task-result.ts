/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 任务级接入的结构化返回；业务失败属于正常数据，工具错误另用错误协议。
 */
export type McpTaskResult =
  | {
      kind: 'capabilities';
      data: {
        schemaVersion: 1;
        generatedAt: string;
        /**
         * @maxItems 100
         */
        supportedTaskKinds: ('browser' | 'verification')[];
        /**
         * @maxItems 100
         */
        supportedExecutors: ('builtin' | 'external')[];
        /**
         * @maxItems 100
         */
        capabilities: {
          [k: string]: unknown;
        }[];
        limits: {
          [k: string]: unknown;
        };
        /**
         * @maxItems 128
         */
        unchecked: string[];
      };
    }
  | {
      kind: 'validation';
      data: {
        valid: boolean;
        /**
         * @maxItems 100
         */
        errors: {
          [k: string]: unknown;
        }[];
        /**
         * @maxItems 100
         */
        warnings: {
          [k: string]: unknown;
        }[];
        definitionDigest: string;
        /**
         * @maxItems 32
         */
        executionPreview: {
          [k: string]: unknown;
        }[];
        /**
         * @maxItems 128
         */
        unchecked: string[];
      };
    }
  | {
      kind: 'submission';
      data: {
        requestId?: string;
        acceptedAt: string;
        /**
         * @maxItems 32
         */
        runs: {
          caseId?: string;
          runId: string;
          origin: 'created' | 'reused';
          executor: {
            kind: 'builtin' | 'external';
          };
        }[];
      };
    }
  | {
      kind: 'operation';
      data: {
        operationId: string;
        status: 'SUCCEEDED';
        effect: 'APPLIED';
        runId?: string;
        requestId?: string;
        /**
         * @maxItems 32
         */
        runs?: {
          caseId?: string;
          runId: string;
          origin: 'created' | 'reused';
          executor: {
            kind: 'builtin' | 'external';
          };
        }[];
        /**
         * @maxItems 100
         */
        affectedRequests?: string[];
        acceptedAt: string;
        /**
         * 受影响请求超过一百条时明确标记，完整关联仍可从各请求读取。
         */
        affectedRequestsTruncated?: boolean;
      };
    }
  | {
      kind: 'run';
      data: {
        runId: string;
        caseId?: string;
        taskKind: 'browser' | 'verification';
        executor: {
          kind: 'builtin' | 'external';
        };
        status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'TIMED_OUT' | 'ERROR';
        reportPhase: 'PENDING' | 'PARTIAL' | 'FINAL';
        reportStatus: ('PASSED' | 'FAILED' | 'INCONCLUSIVE') | null;
        criteriaCounts: {
          [k: string]: unknown;
        } | null;
        summary: string;
        browserResult: {
          [k: string]: unknown;
        } | null;
        /**
         * @maxItems 64
         */
        steps: {
          [k: string]: unknown;
        }[];
        cleanup: {
          [k: string]: unknown;
        } | null;
        queueReason: {
          [k: string]: unknown;
        } | null;
        executionOutcome: {
          [k: string]: unknown;
        } | null;
        closureVerified: boolean;
        /**
         * @maxItems 100
         */
        criteriaPage: {
          runId: string;
          caseId?: string;
          stepId?: string;
          criterionId: string;
          expected: string;
          verdict: ('PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'SKIPPED') | null;
          summary: string;
          /**
           * @maxItems 128
           */
          evidenceRefs: string[];
        }[];
        nextCursor: string | null;
        reportRevision: string;
        textTruncated: boolean;
      };
    }
  | {
      kind: 'request';
      data: {
        requestId: string;
        title: string;
        requestRevision: string;
        summary: {
          [k: string]: unknown;
        };
        /**
         * @maxItems 32
         */
        cases: {
          [k: string]: unknown;
        }[];
        /**
         * @maxItems 100
         */
        criteriaPage: {
          runId: string;
          caseId?: string;
          stepId?: string;
          criterionId: string;
          expected: string;
          verdict: ('PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'SKIPPED') | null;
          summary: string;
          /**
           * @maxItems 128
           */
          evidenceRefs: string[];
        }[];
        nextCursor: string | null;
        reportRevision: string;
        textTruncated: boolean;
      };
    }
  | {
      kind: 'evidence';
      data: {
        runId: string;
        evidenceId: string;
        kind: 'DOM' | 'SCREENSHOT' | 'NETWORK' | 'TRACE' | 'RUNTIME';
        mimeType: string;
        sha256: string;
        size: number;
        uri: string;
        text?: string;
        imageBase64?: string;
        offset?: number;
        nextOffset?: number | null;
        truncated: boolean;
        downloadUrl?: string;
      };
    };
