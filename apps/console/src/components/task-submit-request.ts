import type { CaseResultV2, VerificationCaseV2 } from '@proofrun/contracts';
import type { ApiClient } from '../api';

/** 单 case 直接进入任务（双跑自动展示两组）；批量仍回列表，避免只展示首个 case。 */
export async function submitCaseBatch(
  api: ApiClient,
  cases: VerificationCaseV2[],
  signal: AbortSignal,
): Promise<string> {
  const results = await api.json<CaseResultV2[]>('/v2/cases', signal, cases);
  if (results.length !== 1) return '/tasks';
  const result = results[0]!;
  const id = result.comparison?.arms[0].taskId ?? `case-v2-${result.caseId}`;
  return `/tasks/${encodeURIComponent(id)}`;
}
