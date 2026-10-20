import type { RequestCase } from '../request-presentation';

/** 按执行阶段说明观看能力；任务运行中不代表视频连接已经建立。 */
const ENTRY_COPY = {
  running: {
    title: '实时视频 · 执行现场',
    description: '实时观看浏览器画面，直观看到每一步操作和页面变化。',
    detail: '同时查看执行进度；需要人工处理时可进入处理页，也可取消执行。',
    action: '观看实时视频',
  },
  queued: {
    title: '实时视频 · 等待执行',
    description: '任务启动后，可实时观看浏览器画面和操作过程。',
    detail: '进入详情查看排队进度，或取消本次执行。',
    action: '查看执行详情',
  },
  ended: {
    title: '执行记录',
    description: '执行已结束，可查看执行过程与已保留的证据。',
    detail: '实时视频仅在任务执行期间提供。',
    action: '查看执行详情',
  },
};

/** 请求详情中的观看入口，沿用选定执行及请求溯源，不提前订阅视频。 */
export function RequestExecutionEntry({
  arm,
  requestId,
}: {
  arm: RequestCase['arms'][number];
  requestId: string;
}) {
  const running = arm.result.status === 'RUNNING';
  const copy =
    ENTRY_COPY[
      running ? 'running' : arm.result.status === 'QUEUED' ? 'queued' : 'ended'
    ];
  return (
    <div className="request-execution-entry">
      <div className="request-execution-copy">
        <strong>{copy.title}</strong>
        <p>{copy.description}</p>
        <p className="muted">{copy.detail}</p>
      </div>
      <a
        className={`button ${running ? 'button-primary' : 'button-secondary'}`}
        href={`#/tasks/${encodeURIComponent(arm.taskId)}?request=${encodeURIComponent(requestId)}`}
      >
        {running && (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <rect x="2" y="5" width="14" height="14" rx="3" />
            <path d="m16 10 6-4v12l-6-4" strokeLinejoin="round" />
          </svg>
        )}
        {copy.action}
        <span aria-hidden="true">→</span>
      </a>
    </div>
  );
}
