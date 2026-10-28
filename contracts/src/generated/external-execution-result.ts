/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

export type ExternalExecutionResult =
  | {
      kind: 'operation';
      data: {
        operationId: string;
        controllerId: string;
        runId: string;
        status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN';
        progressApplied: boolean;
        effect: 'UNKNOWN' | 'NOT_STARTED' | 'OBSERVED' | 'APPLIED';
        error: null | {
          code: string;
        };
      };
    }
  | {
      kind: 'controller';
      data: {
        controllerId: string;
        runId: string;
        revision: number;
        state: 'ACTIVE' | 'CLOSED' | 'EXPIRED' | 'LOST';
        runState: string;
        sessionState: string;
        controlMode: string;
        idleDeadlineAt: string;
        closureVerified: boolean;
        pendingOperation: string | null;
        /**
         * 共享执行器的有界上下文投影；budget 使用 decisionCalls，不公开内部租约。
         */
        context: {
          [k: string]: unknown;
        } | null;
        allowedActions: string[];
        nextAction: 'READ_REPORT' | 'HUMAN_REQUIRED' | 'ACT' | 'WAIT';
        executor: {
          kind: 'external';
          judgmentSource: 'external_agent';
          usageSource: 'unavailable';
          decisionCalls: number;
          modelCalls: null;
          promptTokens: null;
          completionTokens: null;
        };
        /**
         * 共享报告构建器校验并产生的结果；未完成时可以为空。
         */
        report: {
          [k: string]: unknown;
        } | null;
      };
    };
