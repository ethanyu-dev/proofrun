import type { ModelCall } from '@proofrun/contracts';

/** 诊断仅存类别；即使错误页回显请求或密钥，也不能把原文带入存档。 */
export type ModelDiagnostics = NonNullable<ModelCall['diagnostics']>;
/** 只检查有界前缀中的固定错误特征，不截取或转发匹配到的供应商文本。 */
const INSPECT_CHARS = 8192;
/** 归一化已知媒体类型，其余头值统一记为 other，避免参数或自定义类型夹带秘密。 */
const MEDIA_TYPES = new Set(['application/json', 'text/html', 'text/plain']);

/** 将响应头缩减为可公开的状态与媒体类型，不保存任意诊断头。 */
export function responseDiagnostics(response: Response): ModelDiagnostics {
  const media = response.headers
    .get('content-type')
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  return {
    phase: 'RESPONSE_BODY',
    httpStatus: response.status,
    contentType: !media
      ? null
      : MEDIA_TYPES.has(media)
        ? (media as ModelDiagnostics['contentType'])
        : 'other',
    responseFormat: 'unknown',
    responseBytes: null,
    reason: 'INVALID_RESPONSE',
  };
}

/** 状态码优先于错误页中的特征；分类只是诊断线索，不声称已定位供应商内部原因。 */
export function responseReason(
  status: number,
  body: string,
): ModelDiagnostics['reason'] {
  const prefix = body.slice(0, INSPECT_CHARS);
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401 || status === 403) return 'AUTH_REJECTED';
  if (
    status === 504 ||
    /gateway[ _-]*timeout|upstream[ _-]*timed?[ _-]*out/i.test(prefix)
  )
    return 'GATEWAY_TIMEOUT';
  if (status >= 500) return 'UPSTREAM_UNAVAILABLE';
  if (/max_tokens_exceeded|context_length_exceeded/i.test(prefix))
    return 'CONTEXT_LIMIT';
  return 'INVALID_RESPONSE';
}

/** 只检测 HTML 标记或空正文，不将任意响应文本转换为用户可见摘要。 */
export function responseFormat(
  body: string,
): ModelDiagnostics['responseFormat'] {
  if (!body.trim()) return 'empty';
  return /^\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(body)
    ? 'html'
    : 'text';
}
