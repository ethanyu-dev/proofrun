import type { ModelCall } from '@proofrun/contracts';

/** 只映射运行时的封闭错误码；原始异常可能包含地址、代理凭据或请求正文。 */
const TRANSPORT_CODES = new Map([
  ['UND_ERR_CONNECT_TIMEOUT', 'TRANSPORT_CONNECT_TIMEOUT'],
  ['UND_ERR_HEADERS_TIMEOUT', 'TRANSPORT_RESPONSE_TIMEOUT'],
  ['UND_ERR_BODY_TIMEOUT', 'TRANSPORT_RESPONSE_TIMEOUT'],
  ['ENOTFOUND', 'TRANSPORT_DNS_ERROR'],
  ['EAI_AGAIN', 'TRANSPORT_DNS_ERROR'],
  ['ECONNRESET', 'TRANSPORT_CONNECTION_RESET'],
]);
/** 细分传输错误仍沿用原有重试/模型回退策略，不增加调用预算。 */
const TRANSIENT_TRANSPORT_CODES = new Set([
  'TRANSPORT_ERROR',
  'TRANSPORT_REQUEST_TIMEOUT',
  ...TRANSPORT_CODES.values(),
]);
/** 只公开稳定错误分类。 */
const ERROR_CODE = /^[A-Z_]{1,80}$/;

/** 错误只保留分类和状态码，不传播带 URL、密钥或页面内容的原始服务错误。 */
export class ExecutionFault extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
    /** 仅携带传输层已归一化的诊断，不传播原始响应或异常。 */
    readonly diagnostics?: ModelCall['diagnostics'],
  ) {
    super(message);
  }
}

export { ExecutionFault as AgentFault };

/** 只有传输失败和临时 HTTP 故障可重试，参数和权限拒绝不能被重试掩盖。 */
export function transient(error: unknown): boolean {
  return (
    error instanceof ExecutionFault &&
    (TRANSIENT_TRANSPORT_CODES.has(error.code) ||
      error.status === 429 ||
      error.status >= 500)
  );
}

/** 存档失败继续阻止派发，仅补充可安全展示的 HTTP 状态与稳定错误码。 */
export function modelTraceFault(
  error: unknown,
  phase: 'start' | 'finish',
): ExecutionFault {
  if (
    error instanceof ExecutionFault &&
    error.code.startsWith('STEP_') &&
    error.code.endsWith('_BUDGET_EXCEEDED')
  )
    return error;
  const details: string[] = [];
  if (error instanceof ExecutionFault) {
    if (
      Number.isInteger(error.status) &&
      error.status >= 400 &&
      error.status <= 599
    )
      details.push(`HTTP ${error.status}`);
    if (ERROR_CODE.test(error.code)) details.push(error.code);
  }
  const message =
    phase === 'start'
      ? '模型请求上下文未能存档，停止派发新请求'
      : '模型回复未能存档，请检查该次调用记录';
  return new ExecutionFault(
    'MODEL_TRACE_UNAVAILABLE',
    `${message}${details.length ? `（${details.join('；')}）` : ''}`,
  );
}
