import { Button } from './ui/button';
import { useEffect, useRef, useState } from 'react';
import { ApiClient, ApiError, errorMessage } from '../api';
import { ErrorNotice } from './ui';
import { rerunTask } from './task-rerun-request';

/** 每个入口固定一个重跑身份；响应不确定时复用身份，不重复创建执行。 */
export function TaskRerun({
  api,
  id,
  paired = false,
  caseId,
  taskKind,
}: {
  api: ApiClient;
  id: string;
  paired?: boolean;
  caseId?: string | null | undefined;
  /** 浏览器重跑保留对应列表与详情的导航归属。 */
  taskKind?: 'browser';
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
      const taskId = await rerunTask(
        api,
        id,
        runId.current,
        controller.signal,
        caseId,
      );
      if (!controller.signal.aborted)
        location.hash = `/${taskKind === 'browser' ? 'browser-tasks' : 'tasks'}/${encodeURIComponent(taskId)}`;
    } catch (error) {
      if (
        error instanceof ApiError &&
        [400, 401, 403, 404, 409, 410, 422].includes(error.status)
      ) {
        runId.current = `rerun-${crypto.randomUUID()}`;
      }
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  };
  return (
    <div className="task-rerun">
      <Button
        variant="outline"
        type="button"
        className="button button-secondary button-small"
        disabled={pending}
        onClick={() => void rerun()}
        title={
          caseId
            ? '保留 caseId，沿用步骤、自动判断身份需求并新增一次运行；新运行使用 LLM 单组，保留历史结果。'
            : '沿用原配置创建新任务；新运行使用 LLM 单组，保留历史结果。'
        }
      >
        {pending
          ? '正在重跑…'
          : caseId
            ? '重跑整个 case'
            : paired
              ? '以 LLM 重跑'
              : '重跑'}
      </Button>
      <ErrorNotice message={error} />
    </div>
  );
}
