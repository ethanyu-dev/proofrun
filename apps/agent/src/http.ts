/** JSON 回复限额覆盖控制面单帧，图片使用独立的 8 MiB 限额。 */
const MAX_JSON_BYTES = 2 * 1024 * 1024;

/** 错误只保留分类和状态码，不传播带 URL、密钥或页面内容的原始服务错误。 */
export class AgentFault extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}
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
/** 每次调用只发出一次请求；是否重试由知道幂等性的调用方决定。 */
export async function jsonRequest(
  url: string,
  token: string,
  method: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs)));
  try {
    const response = await fetch(url, {
      method,
      redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
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
    throw new AgentFault('TRANSPORT_ERROR', '服务请求超时或连接中断');
  }
}
/** 只有传输失败和临时 HTTP 故障可重试，参数和权限拒绝不能被重试掩盖。 */
export function transient(error: unknown): boolean {
  return (
    error instanceof AgentFault &&
    (error.code === 'TRANSPORT_ERROR' ||
      error.status === 429 ||
      error.status >= 500)
  );
}
