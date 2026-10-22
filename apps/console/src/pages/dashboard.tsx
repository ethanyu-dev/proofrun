import { useState } from 'react';
import {
  dashboardRange,
  dashboardToday,
  shiftDashboardDate,
  validDashboardDate,
  type DashboardPeriod,
  type DashboardStatistics,
} from '@proofrun/contracts/dashboard';
import type { ApiClient } from '../api';
import { useResource } from '../use-resource';
import { Empty, ErrorNotice, PageHeader, RefreshBar } from '../components/ui';
import {
  DashboardCharts,
  dashboardRate,
  dashboardTokens,
} from '../components/dashboard-charts';

/** 快捷入口以自然周期为单位，周一开始，不使用含义模糊的最近七天。 */
const PERIODS = [
  ['day', '日'],
  ['week', '周'],
  ['month', '月'],
] as const;
/** 统计卡和日明细使用一致的整数格式。 */
const NUMBER_FORMAT = new Intl.NumberFormat('zh-CN');

/** 统计页面只读取服务端聚合，不从分页任务列表推算全局计数。 */
export function DashboardPage({ api }: { api: ApiClient }) {
  const today = dashboardToday();
  const [period, setPeriod] = useState<DashboardPeriod>('week');
  const [date, setDate] = useState(today);
  const range = dashboardRange(period, date);
  const next = shiftDashboardDate(period, date, 1);
  const resource = useResource<DashboardStatistics>(
    api,
    `/v1/admin/statistics?${new URLSearchParams({ period, date })}`,
    range.endDate >= today,
  );
  const data = resource.data;
  const summary = data?.summary;
  const showDay = (day: string) => {
    setDate(day);
    setPeriod('day');
  };
  return (
    <div className="dashboard-page">
      <PageHeader
        title="验证看板"
        description="从验证规模、通过情况到模型用量，按天追踪项目运行。"
      >
        <a className="button button-secondary" href="#/tasks">
          查看验证任务
        </a>
        <a className="button button-primary" href="#/tasks/new">
          提交任务
        </a>
      </PageHeader>
      <div className="dashboard-toolbar">
        <div className="dashboard-period" role="group" aria-label="统计周期">
          {PERIODS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={period === value}
              onClick={() => setPeriod(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="dashboard-date-navigation">
          <button
            className="button button-secondary button-small"
            aria-label="上一周期"
            disabled={range.startDate <= '2000-01-01'}
            onClick={() => setDate(shiftDashboardDate(period, date, -1))}
          >
            ←
          </button>
          <label>
            统计日期{' '}
            <input
              type="date"
              value={date}
              min="2000-01-01"
              max={today}
              onChange={(event) => {
                if (
                  validDashboardDate(event.target.value) &&
                  event.target.value <= today
                )
                  setDate(event.target.value);
              }}
            />
          </label>
          <button
            className="button button-secondary button-small"
            aria-label="下一周期"
            disabled={next > today}
            onClick={() => setDate(next)}
          >
            →
          </button>
          <button className="text-button" onClick={() => setDate(today)}>
            {period === 'day' ? '今天' : period === 'week' ? '本周' : '本月'}
          </button>
        </div>
        <span className="dashboard-timezone">北京时间 · 周一开始</span>
      </div>
      <div className="dashboard-period-heading">
        <h2>
          {range.startDate === range.endDate
            ? range.startDate
            : `${range.startDate} — ${range.endDate}`}
        </h2>
        <span className="muted">
          {range.endDate >= today
            ? '当前周期 · 数据持续更新'
            : '历史周期 · 当前结果快照'}
        </span>
      </div>
      <RefreshBar {...resource} />
      <ErrorNotice message={resource.error} />
      {!data && (
        <Empty title={resource.loading ? '正在读取统计…' : '统计暂不可用'}>
          {resource.error ? '请刷新重试。' : '正在汇总 Case 与模型调用记录。'}
        </Empty>
      )}
      {data && summary && (
        <>
          <div className="dashboard-kpis">
            <article className="panel dashboard-kpi">
              <span>提交 Case 数</span>
              <strong>{NUMBER_FORMAT.format(summary.cases.total)}</strong>
              <p>
                已结束 {NUMBER_FORMAT.format(summary.cases.finished)} · 进行中{' '}
                {NUMBER_FORMAT.format(summary.cases.pending)}
              </p>
            </article>
            <article className="panel dashboard-kpi">
              <span>通过 Case 数</span>
              <strong>{NUMBER_FORMAT.format(summary.cases.passed)}</strong>
              <p>
                失败 {NUMBER_FORMAT.format(summary.cases.failed)} · 无完整结论{' '}
                {NUMBER_FORMAT.format(summary.cases.inconclusive)}
              </p>
            </article>
            <article className="panel dashboard-kpi">
              <span>Case 通过率</span>
              <strong>{dashboardRate(summary.cases.passRate)}</strong>
              <p>
                {summary.cases.finished
                  ? `${summary.cases.passed} 通过 / ${summary.cases.finished} 已结束`
                  : '暂无已结束 Case'}
              </p>
            </article>
            <article className="panel dashboard-kpi">
              <span>
                Tokens{' '}
                {summary.tokens.unmeasuredCalls ? '（已知部分）' : '总消耗'}
              </span>
              <strong>{dashboardTokens(summary.tokens)}</strong>
              <p>
                {NUMBER_FORMAT.format(summary.tokens.calls)} 次调用
                {summary.tokens.unmeasuredCalls > 0
                  ? ` · ${summary.tokens.unmeasuredCalls} 次用量不完整`
                  : ' · 输入 + 输出'}
              </p>
            </article>
          </div>
          {summary.cases.total === 0 && summary.tokens.calls === 0 && (
            <p className="dashboard-empty" role="status">
              本周期暂无 Case 提交或模型调用。可切换上一周期查看历史记录。
            </p>
          )}
          <DashboardCharts days={data.days} today={today} onDay={showDay} />
          <section
            className="panel dashboard-usage"
            aria-labelledby="usage-heading"
          >
            <div className="dashboard-section-heading">
              <h2 id="usage-heading">用量构成</h2>
              <span className="muted">全部执行组 · 包含重试与清理</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>来源</th>
                    <th>输入 Tokens</th>
                    <th>输出 Tokens</th>
                    <th>合计 Tokens</th>
                    <th>调用次数</th>
                    <th>用量不完整</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['execution', '验证执行'],
                      ['analysis', '报告分析'],
                    ] as const
                  ).map(([key, label]) => (
                    <tr key={key}>
                      <th scope="row">{label}</th>
                      <td>
                        {summary[key].promptTokens === null
                          ? summary[key].calls
                            ? '未上报'
                            : '0'
                          : NUMBER_FORMAT.format(summary[key].promptTokens)}
                      </td>
                      <td>
                        {summary[key].completionTokens === null
                          ? summary[key].calls
                            ? '未上报'
                            : '0'
                          : NUMBER_FORMAT.format(summary[key].completionTokens)}
                      </td>
                      <td>{dashboardTokens(summary[key])}</td>
                      <td>{NUMBER_FORMAT.format(summary[key].calls)}</td>
                      <td>{summary[key].unmeasuredCalls} 次</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {summary.legacyUsageTasks > 0 && (
              <p className="muted">
                包含 {summary.legacyUsageTasks}{' '}
                个旧任务的报告汇总，按任务结束日回填；其真实调用日期无法还原。
              </p>
            )}
          </section>
          <section
            className="panel dashboard-daily"
            aria-labelledby="daily-heading"
          >
            <div className="dashboard-section-heading">
              <h2 id="daily-heading">每日明细</h2>
              <span className="muted">点击日期查看日看板</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>提交 Case</th>
                    <th>通过</th>
                    <th>失败</th>
                    <th>无完整结论</th>
                    <th>进行中</th>
                    <th>通过率</th>
                    <th>执行 Tokens</th>
                    <th>分析 Tokens</th>
                    <th>合计 Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {data.days.map((day) => (
                    <tr key={day.date} data-future={day.date > today}>
                      <th scope="row">
                        {day.date > today ? (
                          <span>{day.date} · 未到</span>
                        ) : (
                          <button
                            className="text-button"
                            onClick={() => showDay(day.date)}
                          >
                            {day.date}
                            {day.date === today ? ' · 今天' : ''}
                          </button>
                        )}
                      </th>
                      {day.date > today ? (
                        <td colSpan={9} className="muted">
                          尚未发生
                        </td>
                      ) : (
                        <>
                          <td>{NUMBER_FORMAT.format(day.cases.total)}</td>
                          <td>{NUMBER_FORMAT.format(day.cases.passed)}</td>
                          <td>{NUMBER_FORMAT.format(day.cases.failed)}</td>
                          <td>
                            {NUMBER_FORMAT.format(day.cases.inconclusive)}
                          </td>
                          <td>{NUMBER_FORMAT.format(day.cases.pending)}</td>
                          <td>{dashboardRate(day.cases.passRate)}</td>
                          <td>{dashboardTokens(day.execution)}</td>
                          <td>{dashboardTokens(day.analysis)}</td>
                          <td>
                            {dashboardTokens(day.tokens)}
                            {day.tokens.unmeasuredCalls > 0 && (
                              <span
                                title={`${day.tokens.unmeasuredCalls} 次调用用量不完整`}
                              >
                                {' '}
                                *
                              </span>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <details className="dashboard-definitions">
            <summary>统计口径与数据完整性</summary>
            <ul>
              <li>
                Case
                按首次提交日归属，显示当前结果；历史结果可能随执行完成而更新。一个普通任务计为一个
                Case，独立清理任务不计入 Case 数。
              </li>
              <li>
                相同执行被多个请求复用只计一次；重跑的新身份计为新一次。历史双跑仅以
                JEV 组判定 Case，缺少 JEV 时沿用实际组。
              </li>
              <li>
                通过率 = 通过 Case / 已结束
                Case。已结束包含失败、受阻、取消、异常及证据不足；排队和执行中不计入分母。周、月按总数计算，不能平均每日通过率。
              </li>
              <li>
                Tokens
                按服务端接收调用的日期累计，包含所有执行组、清理、失败重试及多轮报告分析。跨日执行的
                Tokens 与 Case 提交日期可能不同。
              </li>
              <li>
                缺失的用量不按零估算；有缺失时合计只代表已知部分。旧报告无调用明细时按结束日回填，既无明细也无汇总的历史消耗无法统计。
              </li>
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
