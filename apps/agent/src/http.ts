import type { Dispatcher } from 'undici';

/** JSON 回复限额覆盖控制面单帧，图片使用独立的 8 MiB 限额。 */
const MAX_JSON_BYTES = 2 * 1024 * 1024;
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

export { ExecutionFault as AgentFault } from '@proofrun/execution-core/faults';
import { ExecutionFault as AgentFault } from '@proofrun/execution-core/faults';
/** 可取消等待，关停或租约失效时不再继续下一次领取或浏览器动作。 */
export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
/** 边读边限额，不能先把不受信任回复全部放进内存。 */
export async function readBytes(
  response: Response,
  limit: number,
): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new AgentFault('EMPTY_RESPONSE', '服务返回空内容');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      size += value.length;
      if (size > limit)
        throw new AgentFault('RESPONSE_TOO_LARGE', '服务回复超过限额');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
/** 每次调用只发出一次请求；可信调用方可提供连接策略，但不能绕过总时限、取消及正文限额。 */
export async function jsonRequest(
  url: string,
  token: string,
  method: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
  transport?: (timeoutMs: number, signal: AbortSignal) => Dispatcher,
): Promise<unknown> {
  const duration = Math.max(1, Math.floor(timeoutMs));
  const timeout = AbortSignal.timeout(duration);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  requestSignal.throwIfAborted();
  const dispatcher = transport?.(duration, requestSignal);
  try {
    const response = await fetch(url, {
      ...(dispatcher ? { dispatcher } : {}),
      method,
      redirect: 'error',
      headers: {
        ...extraHeaders,
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: requestSignal,
    });
    const bytes = await readBytes(response, MAX_JSON_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString());
    } catch {
      throw new AgentFault(
        'INVALID_JSON',
        '服务回复不是有效 JSON',
        response.status,
      );
    }
    if (!response.ok) {
      const providerLimit =
        value &&
        typeof value === 'object' &&
        'detail' in value &&
        value.detail &&
        typeof value.detail === 'object' &&
        'error_type' in value.detail &&
        value.detail.error_type === 'max_tokens_exceeded';
      const code = providerLimit
        ? 'MODEL_CONTEXT_TOO_LARGE'
        : value &&
            typeof value === 'object' &&
            'code' in value &&
            typeof value.code === 'string' &&
            /^[A-Z_]{1,80}$/.test(value.code)
          ? value.code
          : 'HTTP_ERROR';
      throw new AgentFault(
        code,
        `服务拒绝请求（HTTP ${response.status}）`,
        response.status,
      );
    }
    return value;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (error instanceof AgentFault) throw error;
    const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
    const code = timeout.aborted
      ? 'TRANSPORT_REQUEST_TIMEOUT'
      : typeof cause?.code === 'string'
        ? (TRANSPORT_CODES.get(cause.code) ?? 'TRANSPORT_ERROR')
        : 'TRANSPORT_ERROR';
    throw new AgentFault(code, '服务请求超时或连接中断');
  } finally {
    // 请求专属连接在成功、拒绝、超时及取消后都释放；默认控制面连接池不受影响。
    await dispatcher?.destroy();
  }
}
/** 只有传输失败和临时 HTTP 故障可重试，参数和权限拒绝不能被重试掩盖。 */
export function transient(error: unknown): boolean {
  return (
    error instanceof AgentFault &&
    (TRANSIENT_TRANSPORT_CODES.has(error.code) ||
      error.status === 429 ||
      error.status >= 500)
  );
}
