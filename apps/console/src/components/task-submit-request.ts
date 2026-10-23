import type { VerificationRequest, RequestResultV2 } from '@proofrun/contracts';
import type { ApiClient } from '../api';

/** 提交 v2 请求封装，成功后进入对应请求详情。 */
export async function submitVerificationRequest(
  api: ApiClient,
  request: VerificationRequest,
  signal: AbortSignal,
): Promise<string> {
  const result = await api.json<RequestResultV2>('/v2/cases', signal, request);
  return `/requests/${encodeURIComponent(result.requestId)}`;
}
