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
         * 共享执行器的有界上下文投影；budget 使用 decisionCalls。timingState=live 时 timeMs 为步骤余额，decisionTimeMs 为本轮余额，stepDeadlineAt/decisionDeadlineAt 为对应 UTC 截止点；GET 和 touch 不重置。inactive 时预算是历史快照。SETTLEMENT_REQUIRED 要求仅整理已有证据。page.coverage 标记投影裁剪，page.network.capture.coverage 描述采集范围；范围完整不等于全页面完整。不公开内部租约。
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
