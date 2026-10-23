import {
  DASHBOARD_TIME_ZONE,
  dashboardRange,
  dashboardToday,
  validDashboardDate,
  summarizeReport,
  type DashboardMetrics,
  type DashboardPeriod,
  type DashboardStatistics,
  type DashboardUsage,
  type ReportFacts,
  type ReportScope,
} from '@proofrun/contracts';
import { Database } from '../../db.js';
import { ApiError } from '../../domain.js';
import {
  DASHBOARD_CASES_SQL,
  DASHBOARD_USAGE_SQL,
  DASHBOARD_RUNS_SQL,
} from './dashboard-query.js';

/** 聚合行的 bigint 由 pg 以字符串返回，转换前不把空值当作零。 */
interface UsageRow {
  /** 服务端北京时间日期。 */
  date: string;
  /** 分开统计执行与异步分析。 */
  kind: 'execution' | 'analysis';
  /** 已上报输入合计。 */
  prompt: string | null;
  /** 已上报输出合计。 */
  completion: string | null;
  /** 包含无用量回复的调用。 */
  calls: string;
  /** 输入或输出缺失的调用。 */
  unmeasured: string;
  /** 使用旧报告回填的任务数。 */
  legacy: string;
}

/** 没有调用记录时保留空用量，页面可依据 calls 区分无调用和未上报。 */
function emptyUsage(): DashboardUsage {
  return {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    calls: 0,
    unmeasuredCalls: 0,
  };
}

/** 空白日也有完整字段，防止图表跨过零数据日造成趋势误读。 */
function emptyMetrics(): DashboardMetrics {
  return {
    runs: 0,
    cases: {
      total: 0,
      finished: 0,
      passed: 0,
      failed: 0,
      inconclusive: 0,
      pending: 0,
      passRate: null,
    },
    execution: emptyUsage(),
    analysis: emptyUsage(),
    tokens: emptyUsage(),
    legacyUsageTasks: 0,
  };
}

/** 合并已知部分，缺失调用数独立累加；任何一级都不平均每日通过率。 */
function mergeUsage(target: DashboardUsage, source: DashboardUsage) {
  for (const field of ['promptTokens', 'completionTokens'] as const)
    if (source[field] !== null)
      target[field] = (target[field] ?? 0) + source[field];
  target.totalTokens =
    target.promptTokens === null && target.completionTokens === null
      ? null
      : (target.promptTokens ?? 0) + (target.completionTokens ?? 0);
  target.calls += source.calls;
  target.unmeasuredCalls += source.unmeasuredCalls;
}

/** 管理员看板在一个只读快照中计算 Case 当前状态和周期内实际用量。 */
export async function dashboardStatistics(
  db: Database,
  query: Record<string, unknown>,
): Promise<DashboardStatistics> {
  const today = dashboardToday();
  const period = query.period ?? 'week';
  const date = query.date ?? today;
  if (
    Object.keys(query).some((key) => !['period', 'date'].includes(key)) ||
    !['day', 'week', 'month'].includes(period as string) ||
    typeof date !== 'string' ||
    !validDashboardDate(date) ||
    date > today
  )
    throw new ApiError(
      400,
      'INVALID_QUERY',
      '请选择有效的日、周或月及不晚于今天的统计日期',
    );
  const range = dashboardRange(period as DashboardPeriod, date);
  return db.transaction(async (client) => {
    await client.query(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    const generatedAt = (
      await client.query<{ at: Date }>('SELECT transaction_timestamp() AS at')
    ).rows[0]!.at.toISOString();
    const days = range.days.map((date) => ({ date, ...emptyMetrics() }));
    const byDate = new Map(days.map((day) => [day.date, day]));
    const runs = await client.query<{ date: string }>(DASHBOARD_RUNS_SQL, [
      range.from,
      range.until,
    ]);
    for (const row of runs.rows) byDate.get(row.date)!.runs++;
    const cases = await client.query<{
      date: string;
      state: string;
      scope: ReportScope;
      report: ReportFacts | null;
    }>(DASHBOARD_CASES_SQL, [range.from, range.until]);
    for (const row of cases.rows) {
      const counts = byDate.get(row.date)!.cases;
      counts.total++;
      if (['QUEUED', 'RUNNING'].includes(row.state)) {
        counts.pending++;
        continue;
      }
      counts.finished++;
      const status = summarizeReport(
        row.report,
        row.scope.acceptanceCriteria.map((c) => c.id),
        row.scope,
      ).reportStatus;
      if (status === 'PASSED') counts.passed++;
      else if (status === 'FAILED') counts.failed++;
      else counts.inconclusive++;
    }
    const usage = await client.query<UsageRow>(DASHBOARD_USAGE_SQL, [
      range.from,
      range.until,
    ]);
    for (const row of usage.rows) {
      const day = byDate.get(row.date)!;
      const value: DashboardUsage = {
        promptTokens: row.prompt === null ? null : Number(row.prompt),
        completionTokens:
          row.completion === null ? null : Number(row.completion),
        totalTokens: null,
        calls: Number(row.calls),
        unmeasuredCalls: Number(row.unmeasured),
      };
      mergeUsage(day[row.kind], value);
      mergeUsage(day.tokens, value);
      day.legacyUsageTasks += Number(row.legacy);
    }
    const summary = emptyMetrics();
    for (const day of days) {
      day.cases.passRate = day.cases.finished
        ? day.cases.passed / day.cases.finished
        : null;
      for (const field of [
        'total',
        'finished',
        'passed',
        'failed',
        'inconclusive',
        'pending',
      ] as const)
        summary.cases[field] += day.cases[field];
      for (const field of ['execution', 'analysis', 'tokens'] as const)
        mergeUsage(summary[field], day[field]);
      summary.runs += day.runs;
      summary.legacyUsageTasks += day.legacyUsageTasks;
    }
    summary.cases.passRate = summary.cases.finished
      ? summary.cases.passed / summary.cases.finished
      : null;
    return {
      period: period as DashboardPeriod,
      timeZone: DASHBOARD_TIME_ZONE,
      startDate: range.startDate,
      endDate: range.endDate,
      generatedAt,
      summary,
      days,
    };
  });
}
