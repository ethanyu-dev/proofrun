/* 根据 contracts/schemas 自动生成，请勿手改；修改 Schema 后运行 pnpm contracts:generate。 */

/**
 * 平台内部执行报告；外部读取 CaseResult。结构有效不代表业务判断已被独立证实。
 */
export type VerificationReport = {
  protocolVersion: '0.1';
  taskId: string;
  lifecycle: 'COMPLETED' | 'CANCELLED' | 'TIMED_OUT';
  executionDisposition: 'EXECUTED' | 'BLOCKED' | 'ERROR';
  verdict: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | null;
  summary: string;
  criteria: {
    criterionId: string;
    verdict: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'SKIPPED';
    summary: string;
    evidenceRefs: string[];
  }[];
  artifacts: {
    id: string;
    kind: 'DOM' | 'SCREENSHOT' | 'NETWORK' | 'TRACE';
    uri: string;
    sha256: string;
  }[];
  executionDetails?: ExecutionDetails;
  /**
   * 结构化任务的逐步执行事实；异常终止仍保留已完成验收。
   *
   * @minItems 1
   * @maxItems 64
   */
  steps?: [StepResult, ...StepResult[]];
};

export interface ExecutionDetails {
  /**
   * 机器可读的执行结束原因；正常验收可为 null。
   */
  reasonCode: string | null;
  /**
   * 配置的模型名称，不包含 API 地址或凭据。
   */
  model: string;
  /**
   * 实际发起的模型请求次数。
   */
  modelCalls: number;
  /**
   * 提交的浏览器写动作数，包含初次导航。
   */
  actions: number;
  /**
   * 从领取到生成报告的耗时。
   */
  elapsedMs: number;
  /**
   * 按提交顺序记录命令，HTTP 重送不添加新身份。
   *
   * Items: 可追溯到控制面结果的命令身份。
   */
  commandIds: string[];
  /**
   * 已解析工具回复中的输入 token 计数；缺失 usage 的调用不计入。
   */
  promptTokens: number;
  /**
   * 已解析工具回复中的输出 token 计数；不能作为完整账单。
   */
  completionTokens: number;
  /**
   * 按实际提供者分别累计请求与已返回的用量；不是账单。
   */
  modelUsage?: {
    model: string;
    calls: number;
    promptTokens: number;
    completionTokens: number;
  }[];
}
export interface StepResult {
  /**
   * 对应规范化步骤的稳定身份。
   */
  stepId: string;
  /**
   * 执行生命周期，与 criteria 中的业务验收结论分开。
   */
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'BLOCKED' | 'ERROR' | 'SKIPPED';
  /**
   * 该步骤已观察事实或未完成原因。
   */
  summary: string;
  /**
   * 本步骤执行事实引用的控制面证据身份。
   */
  evidenceRefs: string[];
  /**
   * 仅包含本步骤已执行的验收项，未执行步骤为空。
   */
  criteria: {
    criterionId: string;
    verdict: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'SKIPPED';
    summary: string;
    evidenceRefs: string[];
  }[];
  /**
   * 步骤开始时间；未开始为 null。
   */
  startedAt: string | null;
  /**
   * 步骤结束时间；未结束或无法确认时为 null。
   */
  finishedAt: string | null;
  /**
   * 稳定的未完成原因码，预算耗尽按受阻记录。
   */
  reasonCode?: string | null;
  /**
   * 本步骤实际用量；清理多步各记录增量，额度由整段清理共享。业务耗时排除人工等待。
   */
  budgetUsage?: {
    elapsedMs: number;
    modelCalls: number;
    actions: number;
    limit: {
      timeoutMs: number;
      maxActions: number;
      maxModelCalls: number;
    };
  };
}
