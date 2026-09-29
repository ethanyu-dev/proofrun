/** 普通读取与写入共用超时；写入失败后不自动重试，防止隐藏未知结果。 */
const REQUEST_TIMEOUT_MS = 15_000;
/** 与节点截图上限一致；DOM 观察也限制在同一读取窗口内。 */
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
/** 只允许固定同源接口，证据返回的 URI 不参与带凭据请求。 */
const API_PATH = /^\/v[12]\/[a-zA-Z0-9_/?=&%+.-]+$/;

/** 可预期的领域错误直接指导用户修正输入，未知错误保留服务端说明。 */
const ERROR_MESSAGES: Record<string, string> = {
  INVALID_TASK: '任务定义无效，请检查必填字段、验收项 ID 和执行预算。',
  TASK_CONFLICT: '此任务 ID 已绑定另一份定义，请核对原任务。',
  UNSUPPORTED_EVIDENCE:
    '当前仅支持 DOM、截图和网络元数据证据，请由上层调整任务定义。',
  TASK_MISSING: '任务不存在，请核对任务 ID。',
  ARTIFACT_MISSING: '证据尚未可用或不存在，请稍后刷新。',
  CONTROL_PLANE_UNAVAILABLE: '控制面暂时不可用，请稍后重试。',
};

/** HTTP 错误保留稳定错误码；页面可以区分权限、缺失和服务不可用。 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 请求使用当前连接的凭据；本地记忆由连接页管理，不写入地址或构建配置。 */
export class ApiClient {
  constructor(private readonly token: string) {}

  /** HTTPS 页面使用 WSS，凭据只进入首条认证消息；画面连接没有输入能力。 */
  live(executionId: string): WebSocket {
    const url = new URL('/v1/live/connect', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    socket.addEventListener('open', () =>
      socket.send(
        JSON.stringify({
          type: 'authenticate',
          token: this.token,
          executionId,
        }),
      ),
    );
    return socket;
  }

  /** 请求固定同源接口，禁止跳转；写操作超时必须先核查结果。 */
  async request(
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<Response> {
    if (!API_PATH.test(path)) throw new Error('接口路径无效');
    let response: Response;
    try {
      response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
        cache: 'no-store',
        redirect: 'error',
        credentials: 'omit',
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ApiError(
        0,
        'CONNECTION_FAILED',
        body === undefined
          ? '无法读取控制面，请检查连接后重试。'
          : '请求结果未确认，请先刷新状态核查；不要重复执行未确认的操作。',
      );
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new ApiError(
        response.status,
        typeof data.code === 'string' ? data.code : 'HTTP_ERROR',
        response.status === 401
          ? '凭据无效或已失效，请检查后重新连接。'
          : typeof data.message === 'string'
            ? data.message
            : `请求失败（${response.status}）`,
      );
    }
    return response;
  }

  async json<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
    const response = await this.request(path, signal, body);
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new ApiError(
        502,
        'INVALID_RESPONSE',
        '接口未返回 JSON，请检查控制面代理配置。',
      );
    return response.json() as Promise<T>;
  }

  /** 流式限制证据大小，并核对报告摘要；页面不会执行 DOM 内容。 */
  async artifact(
    id: string,
    kind: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<Blob> {
    const response = await this.request(
      `/v1/artifacts/${encodeURIComponent(id)}`,
      signal,
    );
    const expected =
      kind === 'SCREENSHOT'
        ? 'image/png'
        : ['DOM', 'NETWORK', 'TRACE'].includes(kind)
          ? 'application/json'
          : null;
    if (
      !expected ||
      response.headers.get('content-type')?.split(';')[0] !== expected
    )
      throw new Error('证据类型与报告不一致');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('证据内容为空');
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > (kind === 'TRACE' ? 64 * 1024 * 1024 : MAX_ARTIFACT_BYTES))
          throw new Error('证据超过可预览大小');
        chunks.push(new Uint8Array(chunk.value));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const blob = new Blob(chunks, { type: expected });
    const bytes = await blob.arrayBuffer();
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    ]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    if (hash !== sha256) throw new Error('证据摘要与报告不一致，已停止展示');
    return blob;
  }
}

/** 对外展示可识别的错误，不暴露请求头或客户端凭据。 */
export function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? `${ERROR_MESSAGES[error.code] ?? error.message} [${error.code}]`
    : error instanceof Error
      ? error.message
      : '请求失败，请重试。';
}
