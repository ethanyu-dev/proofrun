/** 统计固定使用北京时间，自然周从周一开始，不依赖浏览器或数据库会话时区。 */
export const DASHBOARD_TIME_ZONE = 'Asia/Shanghai';
/** 日期运算在 UTC 日期轴上进行；转换统计边界时再附加北京时间偏移。 */
const DAY_MS = 86_400_000;
/** 只接受四位年份的完整日期，防止日期解析器自动纠正非法输入。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 看板选择的是自然周期，趋势始终按天展示。 */
export type DashboardPeriod = 'day' | 'week' | 'month';

/** 按请求创建日归属的 Case 展示行；结果来自各请求当前关联的运行。 */
export interface DashboardCases {
  /** 请求成员数；共享 Case 在不同请求中分别计数，与任务页展示行一致。 */
  total: number;
  /** 所选执行组已终止的数量，包括取消、错误及无结论。 */
  finished: number;
  /** 已终止且所有业务验收项通过。 */
  passed: number;
  /** 已终止且有明确业务失败。 */
  failed: number;
  /** 已终止但无完整结论，包括受阻、取消、错误和证据不足。 */
  inconclusive: number;
  /** 排队或执行中，不参与通过率分母。 */
  pending: number;
  /** passed / finished；无已结束 Case 时为空，不伪造 0%。 */
  passRate: number | null;
}

/** 已上报的实际调用用量；缺失的输入或输出不会被推算。 */
export interface DashboardUsage {
  /** 已知输入 Tokens 合计；无已知值时为空。 */
  promptTokens: number | null;
  /** 已知输出 Tokens 合计；无已知值时为空。 */
  completionTokens: number | null;
  /** 已知部分的合计，不代表供应商账单。 */
  totalTokens: number | null;
  /** 包含失败、在途及重试的调用次数。 */
  calls: number;
  /** 输入或输出尚未上报的调用数。 */
  unmeasuredCalls: number;
}

/** 日明细与周期汇总使用相同字段，周期通过率重新按总数计算。 */
export interface DashboardMetrics {
  /** 本周期创建且仍被可见请求关联的运行数，跨请求复用只计一次。 */
  runs: number;
  /** 按请求创建日归属的 Case 当前关联结果。 */
  cases: DashboardCases;
  /** 当前关联运行的全部执行组及清理调用，按服务端接收调用日归属。 */
  execution: DashboardUsage;
  /** 验证执行总用量，不沿请求关联重复累计。 */
  tokens: DashboardUsage;
  /** 无调用记录的旧报告，按结束日回填用量的任务数。 */
  legacyUsageTasks: number;
}

/** 管理员统计响应只返回聚合事实，不携带任务定义、提示词或凭据。 */
export interface DashboardStatistics {
  /** 用户选择的自然周期。 */
  period: DashboardPeriod;
  /** 固定统计时区。 */
  timeZone: typeof DASHBOARD_TIME_ZONE;
  /** 周期首日，含当天。 */
  startDate: string;
  /** 周期末日，含当天。 */
  endDate: string;
  /** 同一数据库读取快照的生成时间。 */
  generatedAt: string;
  /** 整个周期汇总，不能通过平均每日通过率得到。 */
  summary: DashboardMetrics;
  /** 补齐空白日；尚未到来的日期由页面标记。 */
  days: (DashboardMetrics & { date: string })[];
}

/** 返回北京时间日历日期，避免 UTC 午夜或海外浏览器造成错日。 */
export function dashboardToday(at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DASHBOARD_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** 校验真实日历日期，同时限定应用支持的四位年份范围。 */
export function validDashboardDate(value: string): boolean {
  return (
    DATE_PATTERN.test(value) &&
    value >= '2000-01-01' &&
    value <= '9999-12-31' &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

/** 计算闭开时间边界及连续日期；整月移动使用月首，避免 31 日溢出。 */
export function dashboardRange(period: DashboardPeriod, date: string) {
  if (!validDashboardDate(date)) throw new Error('统计日期无效');
  const start = new Date(`${date}T00:00:00Z`);
  if (period === 'week')
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  if (period === 'month') start.setUTCDate(1);
  const end = new Date(start);
  if (period === 'month') end.setUTCMonth(end.getUTCMonth() + 1);
  else end.setUTCDate(end.getUTCDate() + (period === 'week' ? 7 : 1));
  const days: string[] = [];
  for (let at = start.getTime(); at < end.getTime(); at += DAY_MS)
    days.push(new Date(at).toISOString().slice(0, 10));
  return {
    startDate: days[0]!,
    endDate: days.at(-1)!,
    days,
    from: `${days[0]}T00:00:00+08:00`,
    until: `${end.toISOString().slice(0, 10)}T00:00:00+08:00`,
  };
}

/** 按完整自然周期前后浏览，返回新周期内的锚定日期。 */
export function shiftDashboardDate(
  period: DashboardPeriod,
  date: string,
  direction: -1 | 1,
): string {
  const start = new Date(`${dashboardRange(period, date).startDate}T00:00:00Z`);
  if (period === 'month') start.setUTCMonth(start.getUTCMonth() + direction);
  else
    start.setUTCDate(
      start.getUTCDate() + direction * (period === 'week' ? 7 : 1),
    );
  return start.toISOString().slice(0, 10);
}
