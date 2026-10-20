import type {
  RequestAnalysis,
  RequestMetrics,
  TokenUsage,
} from '@proofrun/contracts';

/** 数字保留精确计数，避免大数缩写掩盖输入、输出合计关系。 */
const TOKEN_FORMAT = new Intl.NumberFormat('zh-CN');

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

/** 状态计数旁并排显示耗时与总量，三类消耗用紧凑明细行表达。 */
export function ReportUsage({
  metrics,
}: {
  metrics: RequestMetrics | undefined;
}) {
  const rows = [
    ['JEV', metrics?.jev],
    ['LLM', metrics?.llm],
    ['Agent 总结（累计）', metrics?.analysis],
  ] as const;
  return (
    <div className="report-usage">
      <dl className="report-usage-stats" aria-label="运行时间与 Tokens">
        <div>
          <dt>验证总运行时间</dt>
          <dd>{durationText(metrics?.executionElapsedMs)}</dd>
        </div>
        <div>
          <dt>Tokens 合计</dt>
          <dd>{tokenText(metrics?.totalTokens)}</dd>
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

/** 输入、输出及本次分析收进同一个明细入口，分析正文不重复展示用量。 */
export function ReportUsageDetails({
  metrics,
  analysisUsage,
}: {
  metrics: RequestMetrics | undefined;
  analysisUsage: RequestAnalysis['usage'];
}) {
  const rows: [string, TokenUsage | undefined][] = [
    ['JEV 验证', metrics?.jev],
    ['LLM 验证', metrics?.llm],
    ['验证执行合计', metrics?.execution],
    ['Agent 总结（本次）', analysisUsage?.current],
    ['Agent 总结（累计）', metrics?.analysis],
  ];
  return (
    <details className="report-usage-detail">
      <summary>用量明细</summary>
      <p className="muted">
        运行时间含人工等待与清理，不含首次排队和异步分析。Tokens
        合计为已记录的验证用量与全部总结用量；验证包含所有执行组和清理，复用
        Case 沿用原执行记录。本次总结用量随重新分析更新，累计用量包含历次分析。
      </p>
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
