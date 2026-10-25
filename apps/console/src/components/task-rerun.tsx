import type { SessionRequest } from '@proofrun/contracts';
import { RerunDialog } from './rerun-dialog';
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
}: {
  api: ApiClient;
  id: string;
  paired?: boolean;
  caseId?: string | null | undefined;
}) {
  const runId = useRef(`rerun-${crypto.randomUUID()}`);
  const draft = useRef<{ session?: SessionRequest } | null>(null);
  const [open, setOpen] = useState(false);
  const active = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => () => active.current?.abort(), []);
  const rerun = async (session?: SessionRequest) => {
    if (active.current) return;
    draft.current ??= session ? { session } : {};
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
        draft.current.session,
      );
      if (!controller.signal.aborted)
        location.hash = `/tasks/${encodeURIComponent(taskId)}`;
    } catch (error) {
      if (
        error instanceof ApiError &&
        [400, 401, 403, 404, 409, 410, 422].includes(error.status)
      ) {
        draft.current = null;
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
        onClick={() => (caseId ? setOpen(true) : void rerun())}
        title={
          caseId
            ? '保留 caseId，沿用步骤和配置新增一次运行；新运行使用 LLM 单组，保留历史结果。'
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
      {caseId ? (
        <RerunDialog
          open={open}
          items={[{ id: caseId, title: caseId }]}
          pending={pending}
          locked={!!draft.current}
          error={error}
          close={() => setOpen(false)}
          submit={(sessions) => void rerun(sessions[caseId])}
        />
      ) : (
        <ErrorNotice message={error} />
      )}
    </div>
  );
}
