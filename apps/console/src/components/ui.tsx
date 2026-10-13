import { useEffect, useState, type ReactNode } from 'react';

/** 固定日期位数并使用 24 小时制，刷新栏不随月份、日期或加载状态改变宽度。 */
const REFRESH_TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** 展示文字明确区分执行状态、产品结论和资源清理状态。 */
const LABELS: Record<string, string> = {
  PENDING: '等待执行',
  QUEUED: '排队中',
  RUNNING: '执行中',
  COMPLETED: '执行完成',
  CANCELLED: '已取消',
  TIMED_OUT: '已超时',
  ERROR: '执行错误',
  WAITING_HUMAN: '等待人工处理',
  HUMAN_TIMEOUT: '人工处理超时',
  ENVIRONMENT_BLOCKED: '环境阻塞',
  EXECUTION_BLOCKED: '执行受阻',
  QUEUE_TIMEOUT: '排队超时',
  EXECUTION_TIMEOUT: '执行超时',
  BUDGET_EXHAUSTED: '执行预算耗尽',
  WORKER_ERROR: '执行器异常',
  NODE_ERROR: '节点异常',
  SESSION_ERROR: '浏览器会话异常',
  MODEL_ERROR: '模型服务异常',
  SERVICE_ERROR: '服务请求异常',
  BROWSER_ERROR: '浏览器操作异常',
  CLEANUP_ERROR: '资源清理异常',
  EXECUTION_ERROR: '执行异常（未分类）',
  EXECUTED: '已执行验收',
  BLOCKED: '执行受阻',
  ENVIRONMENT_NOT_READY: '不符合验证环境',
  PASSED: '验收通过',
  FAILED: '验收失败',
  INCONCLUSIVE: '证据不足',
  SKIPPED: '未验收',
  STARTING: '启动中',
  STOPPING: '停止中',
  FINISHED: '已结束',
  OPENING: '创建中',
  ACTIVE: '会话活跃',
  CLOSING: '关闭中',
  CLOSED: '已关闭',
  QUARANTINED: '等待核实关闭',
};

export function Status({ value }: { value: string | null | undefined }) {
  return (
    <span
      className="status"
      data-tone={
        value === 'PASSED'
          ? 'success'
          : value === 'FAILED' || value === 'ERROR' || value?.endsWith('_ERROR')
            ? 'danger'
            : [
                  'WAITING_HUMAN',
                  'HUMAN_TIMEOUT',
                  'ENVIRONMENT_BLOCKED',
                  'EXECUTION_BLOCKED',
                  'QUEUE_TIMEOUT',
                  'EXECUTION_TIMEOUT',
                  'BUDGET_EXHAUSTED',
                  'BLOCKED',
                  'ENVIRONMENT_NOT_READY',
                  'QUARANTINED',
                  'TIMED_OUT',
                  'INCONCLUSIVE',
                ].includes(value ?? '')
              ? 'warning'
              : 'neutral'
      }
    >
      {value ? (LABELS[value] ?? value) : '尚无结论'}
    </span>
  );
}
export function time(value: string | Date | null | undefined) {
  return value
    ? new Date(value).toLocaleString('zh-CN', { hour12: false })
    : '—';
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </div>
  );
}
export function ErrorNotice({ message }: { message: string | undefined }) {
  return message ? (
    <p className="error-notice" role="alert">
      {message}
    </p>
  ) : null;
}
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <p className="eyebrow">PROOFRUN / CONSOLE</p>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      <div className="page-actions">{children}</div>
    </div>
  );
}
/** 失败时保留上次成功数据，但明确显示更新时间和错误，避免把失联误当空数据。 */
export function RefreshBar({
  loading,
  updatedAt,
  refresh,
}: {
  loading: boolean;
  updatedAt: Date | undefined;
  refresh: () => void;
}) {
  return (
    <div className="refresh-bar">
      <span className="refresh-updated">
        <span>上次读取</span>
        <time
          className="refresh-time"
          dateTime={updatedAt?.toISOString()}
          aria-label={updatedAt ? undefined : '尚未成功读取'}
        >
          {updatedAt
            ? REFRESH_TIME_FORMAT.format(updatedAt)
            : '----/--/-- --:--:--'}
        </time>
      </span>
      <button
        className="text-button"
        disabled={loading}
        aria-busy={loading}
        onClick={refresh}
      >
        刷新
      </button>
    </div>
  );
}
/** 主题只替换语义变量；证据图片保留原始颜色。 */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        'content',
        getComputedStyle(document.documentElement)
          .getPropertyValue('--color-background')
          .trim(),
      );
  }, [dark]);
  return (
    <button
      className="theme-toggle"
      aria-label="深色模式"
      aria-pressed={dark}
      onClick={() => setDark(!dark)}
      title={dark ? '切换浅色模式' : '切换深色模式'}
    >
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M16.5 12A7 7 0 0 1 8 3.5 7 7 0 1 0 16.5 12Z"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
    </button>
  );
}
