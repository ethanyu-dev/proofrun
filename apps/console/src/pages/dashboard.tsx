import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
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
        description="按验证任务中的请求统计 Case，使用各请求当前关联运行的结果。"
      >
        <Button asChild variant="outline">
          <a
            className="button button-secondary"
            href={`#/tasks?${new URLSearchParams({ startDate: range.startDate, endDate: range.endDate })}`}
          >
            查看本周期验证任务
          </a>
        </Button>
        <Button asChild variant="default">
          <a className="button button-primary" href="#/tasks/new">
            提交任务
          </a>
        </Button>
      </PageHeader>
      <div className="dashboard-toolbar">
        <div className="dashboard-period" role="group" aria-label="统计周期">
          {PERIODS.map(([value, label]) => (
            <Button
              variant="ghost"
              key={value}
              type="button"
              aria-pressed={period === value}
              onClick={() => setPeriod(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="dashboard-date-navigation">
          <Button
            variant="outline"
            className="button button-secondary button-small"
            aria-label="上一周期"
            disabled={range.startDate <= '2000-01-01'}
            onClick={() => setDate(shiftDashboardDate(period, date, -1))}
          >
            ←
          </Button>
          <label>
            统计日期{' '}
            <Input
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
          <Button
            variant="outline"
            className="button button-secondary button-small"
            aria-label="下一周期"
            disabled={next > today}
            onClick={() => setDate(next)}
          >
            →
          </Button>
          <Button
            variant="ghost"
            className="text-button"
            onClick={() => setDate(today)}
          >
            {period === 'day' ? '今天' : period === 'week' ? '本周' : '本月'}
          </Button>
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
              <span>请求内 Case 数</span>
              <strong>{NUMBER_FORMAT.format(summary.cases.total)}</strong>
              <p>
                已结束 {NUMBER_FORMAT.format(summary.cases.finished)} · 进行中{' '}
                {NUMBER_FORMAT.format(summary.cases.pending)}
              </p>
            </article>
            <article className="panel dashboard-kpi">
              <span>整体通过 Case 数</span>
              <strong>{NUMBER_FORMAT.format(summary.cases.passed)}</strong>
              <p>
                失败 {NUMBER_FORMAT.format(summary.cases.failed)} · 无完整结论{' '}
                {NUMBER_FORMAT.format(summary.cases.inconclusive)}
              </p>
            </article>
            <article className="panel dashboard-kpi">
              <span>Case 整体通过率</span>
              <strong>{dashboardRate(summary.cases.passRate)}</strong>
              <p>
                {summary.cases.finished
                  ? `${summary.cases.passed} 个整体通过 / ${summary.cases.finished} 个已结束 Case`
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
              本周期暂无请求内 Case 或关联模型调用。可切换上一周期查看历史记录。
            </p>
          )}
          <p>
            本周期创建的当前关联运行数：
            {NUMBER_FORMAT.format(summary.runs ?? 0)}
            （跨请求复用去重，不含已替换的历史运行）
          </p>
          <DashboardCharts days={data.days} today={today} onDay={showDay} />
          <section
            className="panel dashboard-usage"
            aria-labelledby="usage-heading"
          >
            <div className="dashboard-section-heading">
              <h2 id="usage-heading">用量构成</h2>
              <span className="muted">
                当前关联运行 · 全部执行组及清理 · 按调用发生日
              </span>
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
                  <tr>
                    <th scope="row">验证执行</th>
                    <td>
                      {summary.execution.promptTokens === null
                        ? summary.execution.calls
                          ? '未上报'
                          : '0'
                        : NUMBER_FORMAT.format(summary.execution.promptTokens)}
                    </td>
                    <td>
                      {summary.execution.completionTokens === null
                        ? summary.execution.calls
                          ? '未上报'
                          : '0'
                        : NUMBER_FORMAT.format(
                            summary.execution.completionTokens,
                          )}
                    </td>
                    <td>{dashboardTokens(summary.execution)}</td>
                    <td>{NUMBER_FORMAT.format(summary.execution.calls)}</td>
                    <td>{summary.execution.unmeasuredCalls} 次</td>
                  </tr>
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
                    <th>请求内 Case</th>
                    <th>通过</th>
                    <th>失败</th>
                    <th>无完整结论</th>
                    <th>进行中</th>
                    <th>Case 整体通过率</th>
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
                          <Button
                            variant="ghost"
                            className="text-button"
                            onClick={() => showDay(day.date)}
                          >
                            {day.date}
                            {day.date === today ? ' · 今天' : ''}
                          </Button>
                        )}
                      </th>
                      {day.date > today ? (
                        <td colSpan={7} className="muted">
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
                Case 按请求创建日归属，与验证任务页的 Case 展示行一致。同一 Case
                被多个请求复用时，每个请求分别计数；未关联请求的任务不计入。
              </li>
              <li>
                结果取各请求当前关联的未删除运行；独立重跑不会替换请求结果。当前运行使用
                LLM。历史周期也显示当前关联结果。
              </li>
              <li>
                Case 整体通过率 = 整体通过 Case / 已结束
                Case。已结束包含失败、受阻、取消、异常及证据不足；排队和执行中不计入分母。周、月按总数计算，不能平均每日通过率。
                验收项通过数（如 5/9）表示单个 Case 的业务验收进度，不代表该
                Case 整体通过。
              </li>
              <li>
                运行量和 Tokens
                仅统计可见请求当前关联运行，跨请求复用按实际执行去重。
                运行量按运行创建日、Tokens
                按服务端接收调用日归属，包含全部执行组、清理及失败重试； 与 Case
                的请求创建日可能不同，被替换的历史运行不计入。
              </li>
              <li>
                删除的运行及其清理用量不计入统计。缺失的用量不按零估算；有缺失时合计只代表已知部分。旧报告无调用明细时按结束日回填，既无明细也无汇总的历史消耗无法统计。
              </li>
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
