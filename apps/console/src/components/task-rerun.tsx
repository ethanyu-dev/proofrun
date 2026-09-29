import { useEffect, useRef, useState } from 'react';
import { ApiClient, errorMessage } from '../api';
import { ErrorNotice } from './ui';

/** 每个入口固定一个重跑身份；响应不确定时复用身份，不重复创建执行。 */
export function TaskRerun({
  api,
  id,
  paired = false,
}: {
  api: ApiClient;
  id: string;
  paired?: boolean;
}) {
  const runId = useRef(`rerun-${crypto.randomUUID()}`);
  const active = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => () => active.current?.abort(), []);
  const rerun = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(undefined);
    try {
      const result = await api.json<{ taskId: string }>(
        `/v1/tasks/${encodeURIComponent(id)}/rerun`,
        controller.signal,
        { runId: runId.current },
      );
      if (!controller.signal.aborted)
        location.hash = `/tasks/${encodeURIComponent(result.taskId)}`;
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  };
  return (
    <div className="task-rerun">
      <button
        type="button"
        className="button button-secondary button-small"
        disabled={pending}
        onClick={rerun}
        title="沿用原配置创建新任务；对照任务同时重跑两组，保留历史结果。"
      >
        {pending ? '正在重跑…' : paired ? '重跑两组' : '重跑'}
      </button>
      <ErrorNotice message={error} />
    </div>
  );
}
