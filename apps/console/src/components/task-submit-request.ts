import type { VerificationRequest, RequestResultV2 } from '@proofrun/contracts';
import type { CaseResultV2, VerificationCaseV2 } from '@proofrun/contracts';
import type { ApiClient } from '../api';

/** 单 case 直接进入任务；批量仍回列表，避免只展示首个 case。 */
export async function submitCaseBatch(
  api: ApiClient,
  cases: VerificationCaseV2[],
  signal: AbortSignal,
): Promise<string> {
  const results = await api.json<CaseResultV2[]>('/v2/cases', signal, cases);
  if (results.length !== 1) return '/tasks';
  const result = results[0]!;
  const id = result.taskId ?? `case-v2-${result.caseId}`;
  return `/tasks/${encodeURIComponent(id)}`;
}

/** 请求封装与数组兼容入口分别处理，成功后始终进入该请求详情。 */
export async function submitVerificationRequest(
  api: ApiClient,
  request: VerificationRequest,
  signal: AbortSignal,
): Promise<string> {
  const result = await api.json<RequestResultV2>('/v2/cases', signal, request);
  return `/requests/${encodeURIComponent(result.requestId)}`;
}
