import type { RequestAnalysis, TokenUsage } from '@proofrun/contracts';
import { tokenText, UsageDetails } from './report-usage';

/** 分析卡片独立展示本次与累计消耗；优先使用分析轮询结果，避免重跑时显示旧累计。 */
export function AnalysisUsage({
  usage,
  cumulative,
}: {
  /** 当前分析代次及其历史用量，与分析内容一起刷新。 */
  usage: RequestAnalysis['usage'];
  /** 兼容尚未返回分析用量的接口，保留报告中已有的累计计数。 */
  cumulative: TokenUsage | undefined;
}) {
  const total = usage?.cumulative ?? cumulative;
  return (
    <div className="analysis-usage">
      <dl className="report-usage-stats" aria-label="Agent 分析 Tokens">
        <div>
          <dt>本次 Tokens</dt>
          <dd>{tokenText(usage?.current.totalTokens)}</dd>
        </div>
        <div>
          <dt>累计 Tokens</dt>
          <dd>{tokenText(total?.totalTokens)}</dd>
        </div>
      </dl>
      <UsageDetails
        rows={[
          ['Agent 分析（本次）', usage?.current],
          ['Agent 分析（累计）', total],
        ]}
      >
        本次用量随分析进度更新；累计包含历次分析、重新分析及失败调用。未采集的用量显示为横线。
      </UsageDetails>
    </div>
  );
}
