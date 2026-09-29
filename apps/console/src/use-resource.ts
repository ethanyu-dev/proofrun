import { useEffect, useState } from 'react';
import { ApiClient, errorMessage } from './api';

/** 当前可见页面低频刷新，后台标签暂停；完成前不启动下一次请求。 */
const REFRESH_MS = 5000;

/** 读取状态将首次加载、刷新失败与真实空结果分别表达。 */
interface Resource<T> {
  /** 可见数据绑定的路径，防止旧任务闪回。 */
  path: string;
  /** 当前路径上一次成功读取的数据。 */
  data: T | undefined;
  /** 最近读取错误，不用空数组隐藏故障。 */
  error: string | undefined;
  /** 一次请求未结束时禁止重复手动刷新。 */
  loading: boolean;
  /** 本机成功读取时间，不代表业务数据更新时间。 */
  updatedAt: Date | undefined;
}

/** 按请求路径隔离数据，迟到响应不能覆盖切换后的任务或筛选结果。 */
export function useResource<T>(api: ApiClient, path: string, poll = true) {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<Resource<T>>({
    path,
    data: undefined,
    error: undefined,
    loading: true,
    updatedAt: undefined,
  });
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      setState((previous) =>
        previous.path === path
          ? { ...previous, loading: true }
          : {
              path,
              data: undefined,
              error: undefined,
              loading: true,
              updatedAt: undefined,
            },
      );
      try {
        const data = await api.json<T>(path, controller.signal);
        if (!controller.signal.aborted)
          setState({
            path,
            data,
            error: undefined,
            loading: false,
            updatedAt: new Date(),
          });
      } catch (error) {
        if (!controller.signal.aborted)
          setState((previous) => ({
            ...previous,
            loading: false,
            error: errorMessage(error),
          }));
      }
      if (poll && !controller.signal.aborted)
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
  }, [api, path, poll, version]);
  // React 提交新路径到副作用运行之间也不能短暂展示上一任务的数据。
  const current =
    state.path === path
      ? state
      : {
          path,
          data: undefined,
          error: undefined,
          loading: true,
          updatedAt: undefined,
        };
  return { ...current, refresh: () => setVersion((value) => value + 1) };
}
