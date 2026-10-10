import type { CaseResultV2 } from '@proofrun/contracts';
import type { ApiClient } from '../api';

/** case 由服务端整体重建；普通任务继续使用原入口，调用方在重试时保持 runId 不变。 */
export async function rerunTask(
  api: ApiClient,
  id: string,
  runId: string,
  signal: AbortSignal,
  caseId?: string | null,
): Promise<string> {
  if (caseId) {
    const result = await api.json<CaseResultV2>(
      `/v2/cases/${encodeURIComponent(caseId)}/rerun`,
      signal,
      { caseId: runId },
    );
    return result.comparison?.arms[0].taskId ?? `case-v2-${result.caseId}`;
  }
  const result = await api.json<{ taskId: string }>(
    `/v1/tasks/${encodeURIComponent(id)}/rerun`,
    signal,
    { runId },
  );
  return result.taskId;
}
