import type { RequestAnalysis, RequestResultV2 } from '@proofrun/contracts';
import type { ApiClient } from '../api';
import { useResource } from '../use-resource';
import { RequestReportOverview } from './request-report-overview';
import { RequestAnalysis as Analysis } from './request-analysis';

/** 汇总与分析共享一次轮询，本次总结用量随生成进度更新，无需重复请求。 */
export function RequestReportContent({
  api,
  value,
}: {
  api: ApiClient;
  value: RequestResultV2;
}) {
  const resource = useResource<RequestAnalysis | null>(
    api,
    `/v2/requests/${encodeURIComponent(value.requestId)}/analysis`,
  );
  return (
    <>
      <RequestReportOverview
        value={value}
        analysisUsage={resource.data?.usage}
      />
      <Analysis api={api} value={value} resource={resource} />
    </>
  );
}
