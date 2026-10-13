import type { ExecutionOutcome } from './generated/execution-outcome.js';

/** 登录资格与环境缺口只使用稳定原因码，不根据模型自然语言猜测。 */
const ENVIRONMENT_CODES = new Set([
  'ENVIRONMENT_NOT_READY',
  'LOGIN_REQUIRED',
  'IDENTITY_UNAVAILABLE',
  'IDENTITY_PREPARATION_FAILED',
  'MFA_REQUIRED',
]);
/** 生命周期、原始阻塞及终止原因分开保存；历史缺失原因保持未知。 */
export interface ExecutionFacts {
  /** 任务生命周期，不等同于产品验收结论。 */
  state: string;
  /** 控制面记录的终止原因。 */
  code?: string | null;
  /** 执行报告提供的稳定原因码。 */
  reportCode?: string | null;
  /** 报告中的执行完成程度。 */
  disposition?: string | null;
  /** 当前控制权，已恢复 AUTO 的旧阻塞不参与分类。 */
  controlMode?: string | null;
  /** 当前未完成人工请求的原因码。 */
  blockingCode?: string | null;
  /** 人工请求原文，只展示、不解析。 */
  blockingReason?: string | null;
  /** 本轮人工等待开始时间；旧记录可为空。 */
  waitingSince?: string | null;
  /** 本轮固定截止时间，不随链接续期。 */
  waitDeadline?: string | null;
}

/** 所有 API 与 Console 共用分类；后续清理故障不能覆盖最初的环境阻塞。 */
export function executionOutcome(facts: ExecutionFacts): ExecutionOutcome {
  // 旧控制面把所有 worker 错误收口为 AGENT_ERROR，报告中的具体码仍然有效。
  const code =
    facts.code === 'AGENT_ERROR'
      ? (facts.reportCode ?? facts.code)
      : (facts.code ?? facts.reportCode ?? null);
  const unresolved = !!facts.controlMode && facts.controlMode !== 'AUTO';
  const environment =
    ENVIRONMENT_CODES.has(facts.blockingCode ?? '') && unresolved;
  let category: ExecutionOutcome['category'];
  if (facts.state === 'CANCELLED') category = 'CANCELLED';
  else if (facts.state === 'QUEUED') category = 'QUEUED';
  else if (facts.state === 'RUNNING')
    category = unresolved ? 'WAITING_HUMAN' : 'RUNNING';
  else if (code === 'HUMAN_INTERVENTION_TIMEOUT') category = 'HUMAN_TIMEOUT';
  else if (environment || ENVIRONMENT_CODES.has(code ?? ''))
    category = 'ENVIRONMENT_BLOCKED';
  else if (code === 'TASK_QUEUE_TIMEOUT') category = 'QUEUE_TIMEOUT';
  else if (code?.includes('BUDGET_EXCEEDED')) category = 'BUDGET_EXHAUSTED';
  else if (code?.startsWith('CLEANUP_') || code === 'CLOSURE_UNVERIFIED')
    category = 'CLEANUP_ERROR';
  else if (facts.state === 'TIMED_OUT') category = 'EXECUTION_TIMEOUT';
  else if (code === 'WORKER_LEASE_EXPIRED' || code === 'AGENT_ERROR')
    category = 'WORKER_ERROR';
  else if (code?.startsWith('NODE_')) category = 'NODE_ERROR';
  else if (
    code?.startsWith('SESSION_') ||
    code === 'HOST_EXITED' ||
    code === 'HOST_CHANNEL_CLOSED'
  )
    category = 'SESSION_ERROR';
  else if (
    code?.startsWith('MODEL_') ||
    code?.startsWith('LLM_') ||
    code === 'INVALID_MODEL_DECISION' ||
    code === 'RETRYABLE_MODEL_ERROR'
  )
    category = 'MODEL_ERROR';
  else if (
    [
      'TRANSPORT_ERROR',
      'HTTP_ERROR',
      'INVALID_JSON',
      'EMPTY_RESPONSE',
      'RESPONSE_TOO_LARGE',
    ].includes(code ?? '')
  )
    category = 'SERVICE_ERROR';
  else if (
    code?.startsWith('BROWSER_') ||
    code?.startsWith('DOM_') ||
    code === 'COMMAND_DEADLINE_EXCEEDED'
  )
    category = 'BROWSER_ERROR';
  else if (
    facts.disposition === 'BLOCKED' ||
    code === 'NO_PROGRESS' ||
    code === 'WORKFLOW_RECOVERY_EXHAUSTED'
  )
    category = 'EXECUTION_BLOCKED';
  else if (facts.state === 'ERROR' || facts.disposition === 'ERROR')
    category = 'EXECUTION_ERROR';
  else category = 'COMPLETED';
  return {
    category,
    reasonCode: environment ? facts.blockingCode! : code,
    terminationCode: ['QUEUED', 'RUNNING'].includes(facts.state)
      ? null
      : (facts.code ?? null),
    detail: unresolved ? (facts.blockingReason ?? null) : null,
    waitingSince: facts.waitingSince ?? null,
    waitDeadline: facts.waitDeadline ?? null,
  };
}
