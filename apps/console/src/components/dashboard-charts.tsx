import { Button } from './ui/button';
import type { DashboardStatistics, DashboardUsage } from '@proofrun/contracts';

/** 展示完整整数，图形只辅助趋势，精确值始终可以在明细表读取。 */
const NUMBER_FORMAT = new Intl.NumberFormat('zh-CN');
/** 堆叠颜色与说明共用同一顺序，不能仅凭颜色解释结论。 */
const CASE_SERIES = [
  ['passed', '通过'],
  ['failed', '失败'],
  ['inconclusive', '无完整结论'],
  ['pending', '进行中'],
] as const;

/** 比例为空表示没有已结束 Case，不能渲染成 0%。 */
export function dashboardRate(value: number | null) {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

/** 零调用可显示 0；有调用但全部缺失时显示未上报，部分缺失标记为已知量。 */
export function dashboardTokens(usage: DashboardUsage) {
  if (usage.calls === 0 && usage.totalTokens === null) return '0';
  if (usage.totalTokens === null) return '未上报';
  return NUMBER_FORMAT.format(usage.totalTokens);
}

/** 双图共用日期轴语义，按钮支持键盘选日；未来日不伪装成已经发生的零值。 */
export function DashboardCharts({
  days,
  today,
  onDay,
}: {
  days: DashboardStatistics['days'];
  today: string;
  onDay: (date: string) => void;
}) {
  const maxCases = Math.max(1, ...days.map((day) => day.cases.total));
  const maxTokens = Math.max(
    1,
    ...days.map((day) => day.tokens.totalTokens ?? 0),
  );
  return (
    <div className="dashboard-charts">
      <section
        className="panel dashboard-chart"
        aria-labelledby="case-chart-title"
      >
        <div className="dashboard-section-heading">
          <h2 id="case-chart-title">Case 日趋势</h2>
          <span className="muted">按请求创建日 · 当前关联结果</span>
        </div>
        <div className="dashboard-legend">
          {CASE_SERIES.map(([key, label]) => (
            <span key={key}>
              <i data-series={key} />
              {label}
            </span>
          ))}
        </div>
        <div
          className="dashboard-plot"
          style={{
            gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`,
          }}
        >
          {days.map((day, index) => (
            <Button
              variant="ghost"
              size="content"
              type="button"
              className="dashboard-bar-column"
              key={day.date}
              disabled={day.date > today}
              onClick={() => onDay(day.date)}
              title={`${day.date}：${day.cases.total} 个 Case，通过率 ${dashboardRate(day.cases.passRate)}`}
              aria-label={`${day.date}，${day.cases.total} 个 Case，通过 ${day.cases.passed}，失败 ${day.cases.failed}，无完整结论 ${day.cases.inconclusive}，进行中 ${day.cases.pending}，查看当日`}
            >
              <span className="dashboard-bar-space">
                {day.date <= today && (
                  <span
                    className="dashboard-stack"
                    style={{ height: `${(day.cases.total / maxCases) * 100}%` }}
                  >
                    {CASE_SERIES.map(([key]) => (
                      <span
                        key={key}
                        data-series={key}
                        style={{ flex: day.cases[key] }}
                      />
                    ))}
                  </span>
                )}
              </span>
              <span className="dashboard-tick">
                {days.length <= 7 ||
                index % 5 === 0 ||
                index === days.length - 1
                  ? day.date.slice(5)
                  : '\u00a0'}
              </span>
            </Button>
          ))}
        </div>
        <p className="muted">
          峰值{' '}
          {NUMBER_FORMAT.format(
            maxCases === 1 && days.every((d) => d.cases.total === 0)
              ? 0
              : maxCases,
          )}{' '}
          个 / 日 · 点击柱形查看当日统计
        </p>
      </section>
      <section
        className="panel dashboard-chart"
        aria-labelledby="token-chart-title"
      >
        <div className="dashboard-section-heading">
          <h2 id="token-chart-title">Tokens 日趋势</h2>
          <span className="muted">按调用发生日</span>
        </div>
        <div className="dashboard-legend">
          <span>
            <i data-series="execution" />
            验证执行
          </span>
        </div>
        <div
          className="dashboard-plot"
          style={{
            gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`,
          }}
        >
          {days.map((day, index) => (
            <Button
              variant="ghost"
              size="content"
              type="button"
              className="dashboard-bar-column"
              key={day.date}
              disabled={day.date > today}
              onClick={() => onDay(day.date)}
              title={`${day.date}：${dashboardTokens(day.tokens)} Tokens，${day.tokens.unmeasuredCalls} 次调用用量不完整`}
              aria-label={`${day.date}，Tokens ${dashboardTokens(day.tokens)}，${day.tokens.unmeasuredCalls} 次调用用量不完整，查看当日`}
            >
              <span className="dashboard-bar-space">
                {day.date <= today && (
                  <span
                    className="dashboard-stack"
                    style={{
                      height: `${((day.tokens.totalTokens ?? 0) / maxTokens) * 100}%`,
                    }}
                  >
                    <span
                      data-series="execution"
                      style={{ flex: day.execution.totalTokens ?? 0 }}
                    />
                  </span>
                )}
                {day.date <= today && day.tokens.unmeasuredCalls > 0 && (
                  <span className="dashboard-missing" aria-hidden="true">
                    *
                  </span>
                )}
              </span>
              <span className="dashboard-tick">
                {days.length <= 7 ||
                index % 5 === 0 ||
                index === days.length - 1
                  ? day.date.slice(5)
                  : '\u00a0'}
              </span>
            </Button>
          ))}
        </div>
        <p className="muted">
          峰值{' '}
          {NUMBER_FORMAT.format(
            Math.max(0, ...days.map((d) => d.tokens.totalTokens ?? 0)),
          )}{' '}
          Tokens / 日 · * 用量尚不完整
        </p>
      </section>
    </div>
  );
}
