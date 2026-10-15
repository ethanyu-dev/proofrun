import { DELIVERY_TIMEOUT_MS, type IntegrationConnection } from './config.js';

/** 外部返回只允许小型元数据，避免远端服务异常耗尽 API 内存。 */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** HTTP 错误只携带状态和退避时间，不保存远端正文、凭据或处理链接。 */
export class RemoteError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs = 0,
  ) {
    super(`Notification service HTTP ${status}`);
  }
}
/** 固定配置的服务 origin，不跟随重定向；单次传输受超时与关闭信号共同约束。 */
export async function remote(
  connection: IntegrationConnection,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(DELIVERY_TIMEOUT_MS);
  const response = await fetch(new URL(path, connection.url), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${connection.deliveryToken}`,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    const header = response.headers.get('retry-after');
    const retryAfter = header
      ? /^\d+$/.test(header)
        ? Number(header) * 1000
        : Math.max(0, Date.parse(header) - Date.now())
      : 0;
    await response.body?.cancel();
    throw new RemoteError(
      response.status,
      Number.isFinite(retryAfter) ? retryAfter : 0,
    );
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body)
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new Error('Notification response too large');
      chunks.push(chunk);
    }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
