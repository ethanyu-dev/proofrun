import { useEffect, useState, type ReactNode } from 'react';

/** 展示文字明确区分执行状态、产品结论和资源清理状态。 */
const LABELS: Record<string, string> = {
  PENDING: '等待执行',
  QUEUED: '排队中',
  RUNNING: '执行中',
  COMPLETED: '执行完成',
  CANCELLED: '已取消',
  TIMED_OUT: '已超时',
  ERROR: '执行错误',
  EXECUTED: '已执行验收',
  BLOCKED: '执行受阻',
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
          : value === 'FAILED' || value === 'ERROR'
            ? 'danger'
            : ['BLOCKED', 'QUARANTINED', 'TIMED_OUT', 'INCONCLUSIVE'].includes(
                  value ?? '',
                )
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
      <span>{updatedAt ? `上次读取 ${time(updatedAt)}` : '等待首次读取'}</span>
      <button className="text-button" disabled={loading} onClick={refresh}>
        {loading ? '读取中…' : '刷新'}
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
