import type {
  NodeCommand,
  NodeEvent,
  ExecutionGrant,
  VerificationReport,
  StepResult,
  ModelCallWrite,
  ControlRequest,
} from '@proofrun/contracts';
export type BrowserOperation = Extract<
  NodeCommand['command'],
  {
    type:
      | 'browser.act'
      | 'browser.observe'
      | 'browser.wait'
      | 'browser.cookies.clear'
      | 'browser.trace'
      | 'browser.identity.prepare';
  }
>;
export type CommandResult = Extract<NodeEvent, { type: 'command.result' }>;
/** 执行视图只用于生命周期控制；节点和会话身份始终来自领取响应。 */
export interface ExecutionView extends ExecutionTiming {
  /** 仅来自独立人工处理页逐项确认，普通 resume 不会携带此证据。 */
  humanConfirmation?: {
    revision: number;
    items: string[];
    conditionKeys?: string[];
    authRevision?: number;
  };
  /** 节点实际启动回执，不接受模型声明。 */
  environmentProof?: {
    sessionId: string;
    initialState: string;
    authRestored: boolean;
    /** 节点回读验证的动画偏好；旧记录缺失时不能推断为已启用。 */
    reducedMotion?: boolean;
  };
  /** 认证版本只随可能改变身份的操作增长。 */
  authRevision?: number;
  /** 任务终态用于撤销模型调用，不依赖模型理解取消文本。 */
  taskState: string;
  /** 操作权与代次独立于任务生命周期，暂停期间仍由原 worker 续租。 */
  controlMode: 'AUTO' | 'REQUESTED' | 'HUMAN';
  controlRevision: number;
  actionCount: number;
  /** 浏览器会话就绪和关闭进度。 */
  state: string;
  closureVerified: boolean;
  /** 控制面签发的 worker 权限期限。 */
  leaseExpiresAt: string;
  /** 服务端登记的证据及交付状态，不接受模型自报的 URL。 */
  artifacts: Array<{ id: string; kind: string; sha256: string; state: string }>;
}

/** 控制面时间快照；旧版心跳未带这些字段时不能自行推断预算已刷新。 */
export interface ExecutionTiming {
  /** profile 中各步骤独立计时，客户端只投影当前组。 */
  stepBudgets?: Record<string, NonNullable<ExecutionTiming['stepBudget']>>;
  taskDeadlineAt?: string;
  /** 当前步骤的服务端计时与计数；旧 worker 不会领取携带此策略的新任务。 */
  stepBudget?: {
    stepId: string;
    deadlineAt: number;
    actions: number;
    modelCalls: number;
    pausedAt: number | null;
  } | null;
  /** 控制面首次进入清理时固定的期限，不能被较早的业务心跳覆盖。 */
  cleanupDeadlineAt?: string | null;
  leaseExpiresAt?: string;
  controlMode?: 'AUTO' | 'REQUESTED' | 'HUMAN';
  controlRevision?: number;
}

/** 浏览器和持久化端口；实现可为 HTTP worker 适配器或服务端 runtime 驱动。 */
export interface ControlClient {
  /** 只读生命周期、证据和权威时钟，不产生新的执行权限。 */
  view(execution: ExecutionGrant, signal?: AbortSignal): Promise<ExecutionView>;
  /** 宿主提供租约快照；服务端实现只读，Worker 实现才真正续租。 */
  heartbeat(
    execution: ExecutionGrant,
    signal: AbortSignal,
  ): Promise<ExecutionTiming & { leaseExpiresAt: string }>;
  /** 稳定命令身份原样重送，未知副作用不能换键重试。 */
  command(
    execution: ExecutionGrant,
    commandId: string,
    operation: BrowserOperation,
    timeoutMs: number,
    signal: AbortSignal,
    controlRevision?: number,
    stepId?: string,
  ): Promise<CommandResult>;
  /** 返回经过归属、摘要和大小校验的一张图片。 */
  image(
    execution: ExecutionGrant,
    artifact: { id: string; sha256: string },
    signal: AbortSignal,
  ): Promise<string>;
  /** 交付规则生成的报告，控制面仍核实事实与控制代次。 */
  complete(
    execution: ExecutionGrant,
    report: VerificationReport,
    controlRevision?: number,
  ): Promise<void>;
  /** 保存逐步事实并返回当前预算时钟。 */
  recordSteps(
    execution: ExecutionGrant,
    steps: StepResult[],
  ): Promise<ExecutionTiming | void>;
  /** 请求先存档，回复后补齐，两阶段复用同一调用身份。 */
  recordModelCall(
    execution: ExecutionGrant,
    id: string,
    body: ModelCallWrite,
  ): Promise<void>;
  /** 请求人工操作，不能自行确认人工条件。 */
  intervene(
    execution: ExecutionGrant,
    controlRevision: number,
    reason: string,
    signal: AbortSignal,
    items?: string[],
    reasonCode?: Extract<
      ControlRequest,
      { type: 'execution.intervene' }
    >['reasonCode'],
    conditionKeys?: string[],
  ): Promise<void>;
  /** 只有安全检查点可以确认允许人工接管。 */
  acknowledge(
    execution: ExecutionGrant,
    controlRevision: number,
    signal: AbortSignal,
  ): Promise<void>;
}
