import type { RequestMetrics, TokenUsage } from '@proofrun/contracts';
import type { ReactNode } from 'react';

/** 数字保留精确计数，避免大数缩写掩盖输入、输出合计关系。 */
const TOKEN_FORMAT = new Intl.NumberFormat('zh-CN');

/** 历史模式即使用量缺失也保留占位；实际调用记录可补足旧报告缺少模式信息的情况。 */
function verificationUsageRows(
  metrics: RequestMetrics | undefined,
  historicalJev: boolean,
): [string, TokenUsage | undefined][] {
  const jev = metrics?.jev;
  const hasJev =
    historicalJev ||
    (jev !== undefined &&
      [jev.calls, jev.promptTokens, jev.completionTokens, jev.totalTokens].some(
        (value) => value != null && value > 0,
      ));
  return [
    ...(hasJev
      ? [['JEV（历史）', jev] as [string, TokenUsage | undefined]]
      : []),
    ['LLM', metrics?.llm],
  ];
}

/** 历史未采集用横线占位，不渲染告警，也不把空值显示成零消耗。 */
export function tokenText(value: number | null | undefined): string {
  return value == null ? '—' : TOKEN_FORMAT.format(value);
}

/** 墙钟跨度以秒为最小展示单位；并发 Case 不逐项相加。 */
export function durationText(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return [
    hours ? `${hours} 小时` : '',
    minutes ? `${minutes} 分` : '',
    `${seconds % 60} 秒`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** 顶部展示验证执行用量，与导出报告保持一致。 */
export function ReportUsage({
  metrics,
  historicalJev = false,
}: {
  metrics: RequestMetrics | undefined;
  /** 由请求的冻结执行组判断，不根据用量缺失推断为当前模式。 */
  historicalJev?: boolean;
}) {
  const rows = verificationUsageRows(metrics, historicalJev);
  return (
    <div className="report-usage">
      <dl className="report-usage-stats" aria-label="运行时间与 Tokens">
        <div>
          <dt>验证总运行时间</dt>
          <dd>{durationText(metrics?.executionElapsedMs)}</dd>
        </div>
        <div>
          <dt>验证 Tokens 合计</dt>
          <dd>{tokenText(metrics?.execution.totalTokens)}</dd>
        </div>
      </dl>
      <dl className="report-usage-breakdown" aria-label="Tokens 拆分">
        {rows.map(([label, usage]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{tokenText(usage?.totalTokens)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** 验证明细包含所有执行组和清理，与顶部验证合计保持相同口径。 */
export function ReportUsageDetails({
  metrics,
  historicalJev = false,
}: {
  metrics: RequestMetrics | undefined;
  /** 与顶部用量使用同一历史模式判断，避免明细重新露出空 JEV 行。 */
  historicalJev?: boolean;
}) {
  const rows: [string, TokenUsage | undefined][] = [
    ...verificationUsageRows(metrics, historicalJev).map(
      ([label, usage]): [string, TokenUsage | undefined] => [
        `${label} 验证`,
        usage,
      ],
    ),
    ['验证执行合计', metrics?.execution],
  ];
  return (
    <UsageDetails rows={rows}>
      运行时间含人工等待与清理，不含首次排队。验证 Tokens
      合计包含所有执行组和清理，复用 Case 沿用原执行记录。
    </UsageDetails>
  );
}

/** 折叠表格展示验证执行用量及统计口径。 */
export function UsageDetails({
  rows,
  children,
}: {
  /** 行标题与已采集用量；未知值继续显示横线。 */
  rows: [string, TokenUsage | undefined][];
  /** 解释当前区域的计量范围。 */
  children: ReactNode;
}) {
  return (
    <details className="report-usage-detail">
      <summary>用量明细</summary>
      <p className="muted">{children}</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>用途</th>
              <th>输入 Tokens</th>
              <th>输出 Tokens</th>
              <th>合计 Tokens</th>
              <th>模型调用</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, usage]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>{tokenText(usage?.promptTokens)}</td>
                <td>{tokenText(usage?.completionTokens)}</td>
                <td>{tokenText(usage?.totalTokens)}</td>
                <td>{tokenText(usage?.calls)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
