import { useEffect, useState } from 'react';
import type { ExecutionTimeline } from '@proofrun/contracts';
import { ApiClient, errorMessage } from './api';

/** 操作记录低频同步；画面仍由实时通道独立推送。 */
const REFRESH_MS = 5000;

/** 顺序读完所有分页，失败保留已有记录并显式报错；切换执行时中止旧请求。 */
export function useExecutionTimeline(
  api: ApiClient,
  executionId: string,
  active: boolean,
) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<{
    id: string;
    commands: ExecutionTimeline['commands'];
    loading: boolean;
    error?: string | undefined;
  }>({ id: executionId, commands: [], loading: true });
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      setState((previous) =>
        previous.id === executionId
          ? { ...previous, loading: true, error: undefined }
          : { id: executionId, commands: [], loading: true },
      );
      try {
        const commands: ExecutionTimeline['commands'] = [];
        const seen = new Set<string>();
        let cursor: string | null = null;
        do {
          const page: ExecutionTimeline = await api.json(
            `/v1/admin/executions/${encodeURIComponent(executionId)}/timeline${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`,
            controller.signal,
          );
          commands.push(...page.commands);
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor))
            throw new Error('操作记录分页异常，请重试。');
          if (cursor) seen.add(cursor);
        } while (cursor && !controller.signal.aborted);
        if (!controller.signal.aborted)
          setState({ id: executionId, commands, loading: false });
      } catch (error) {
        if (!controller.signal.aborted)
          setState((previous) => ({
            ...previous,
            loading: false,
            error: errorMessage(error),
          }));
      }
      if (active && !controller.signal.aborted)
        timer = setTimeout(tick, REFRESH_MS);
    };
    const tick = () => {
      if (document.hidden) timer = setTimeout(tick, REFRESH_MS);
      else void read();
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, executionId, active, version]);
  return {
    ...(state.id === executionId
      ? state
      : { id: executionId, commands: [], loading: true }),
    refresh: () => setVersion((v) => v + 1),
  };
}
