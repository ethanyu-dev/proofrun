import { useEffect, useState } from 'react';
import type { TaskDetail, TaskList } from '@proofrun/contracts';
import { ApiClient } from './api';
import {
  verificationProgress,
  type VerificationProgress,
} from './report-presentation';

/** 列表只补读双跑组或尚无统计的任务，限制并发以避免同时拉取整页报告。 */
const READ_CONCURRENCY = 3;
/** 一轮读取完成后再计时，慢请求不会被列表自身的刷新反复取消。 */
const REFRESH_MS = 5000;

/** 任务和双跑组采用不同命名空间，跨页仍以持久关联去重。 */
function progressKey(task: TaskList['tasks'][number]) {
  return task.comparison
    ? `comparison:${task.comparison.id}`
    : `task:${task.id}`;
}

/** 列表计数跨分页读取关联组，不把当前页恰好出现的任务当作完整双跑。 */
export function useListProgress(
  api: ApiClient,
  list: TaskList | undefined,
  poll = true,
  refreshedAt?: Date,
) {
  const groups = new Map<string, [string, string, boolean]>();
  for (const task of list?.tasks ?? []) {
    if (task.comparison || !task.criteriaCounts) {
      const key = progressKey(task);
      groups.set(key, [key, task.id, !!task.comparison]);
    }
  }
  // 只在读取范围变化时重建队列；普通列表轮询不会中断正在补读的后半页。
  const targets = JSON.stringify([...groups.values()]);
  const [snapshot, setSnapshot] = useState<{
    targets: string;
    api: ApiClient;
    counts: Map<string, VerificationProgress>;
    error: boolean;
  }>();
  const refreshVersion = poll ? undefined : refreshedAt?.getTime();
  useEffect(() => {
    const entries = JSON.parse(targets) as [string, string, boolean][];
    if (!entries.length) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const counts = new Map<string, VerificationProgress>();
    let initial = true;
    const tick = async () => {
      if (initial || !document.hidden) {
        initial = false;
        let next = 0;
        let error = false;
        // 相同双跑组只读取一次，保留本轮尚未刷新的计数以免每五秒闪回占位。
        const read = async () => {
          while (next < entries.length && !controller.signal.aborted) {
            const [key, id, paired] = entries[next++]!;
            try {
              let tasks: TaskDetail[];
              const path = `/v1/tasks/${encodeURIComponent(id)}`;
              if (paired) {
                const result = await api.json<{
                  comparison: null | { arms: TaskDetail[] };
                }>(`${path}/comparison`, controller.signal);
                tasks = result.comparison?.arms ?? [];
                if (!tasks.length) throw new Error('双跑记录缺失');
              } else
                tasks = [await api.json<TaskDetail>(path, controller.signal)];
              counts.set(key, verificationProgress(tasks));
            } catch {
              counts.delete(key);
              error = true;
            }
            if (!controller.signal.aborted)
              setSnapshot({ targets, api, counts: new Map(counts), error });
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(READ_CONCURRENCY, entries.length) },
            read,
          ),
        );
      }
      if (poll && !controller.signal.aborted)
        timer = setTimeout(tick, REFRESH_MS);
    };
    void tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, targets, poll, refreshVersion]);
  const current =
    snapshot?.targets === targets && snapshot.api === api
      ? snapshot
      : undefined;
  return {
    error: current?.error,
    counts(task: TaskList['tasks'][number]) {
      if (!task.comparison && task.criteriaCounts) return task.criteriaCounts;
      return current?.counts.get(progressKey(task));
    },
  };
}
