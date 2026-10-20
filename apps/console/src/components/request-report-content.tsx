import type { RequestAnalysis, RequestResultV2 } from '@proofrun/contracts';
import { requestVerification } from '@proofrun/contracts/request-verification';
import type { ApiClient } from '../api';
import { useResource } from '../use-resource';
import { RequestReportOverview } from './request-report-overview';
import { RequestAnalysis as Analysis } from './request-analysis';

/** 全部成功时只显示验证汇总，不挂载分析区域，也不发起分析查询或生成。 */
export function RequestReportContent({
  api,
  value,
}: {
  api: ApiClient;
  value: RequestResultV2;
}) {
  return (
    <>
      <RequestReportOverview value={value} />
      {requestVerification(value).status !== 'success' && (
        <ReportAnalysis key={value.requestId} api={api} value={value} />
      )}
    </>
  );
}

/** 条件挂载隔离分析轮询；切换为全部成功时自动清理在途请求与定时器。 */
function ReportAnalysis({
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
  return <Analysis api={api} value={value} resource={resource} />;
}
