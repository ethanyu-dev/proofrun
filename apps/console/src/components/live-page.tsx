import { useEffect, useRef, useState } from 'react';
import type { TaskDetail } from '@proofrun/contracts';
import { ApiClient } from '../api';

/** 保留最后一帧供终态对照；重新连接只订阅画面，绝不重发浏览器动作。 */
export function LivePage({
  api,
  execution,
  active,
}: {
  api: ApiClient;
  execution: TaskDetail['executions'][number];
  active: boolean;
}) {
  const human = active && execution.control_mode !== 'AUTO';
  const handoff = human && execution.control_mode === 'REQUESTED';
  const latestFrameAt = useRef(0);
  const [frame, setFrame] = useState<string>();
  const [state, setState] = useState(active ? '正在连接画面' : '执行已结束');
  const [count, setCount] = useState(execution.action_count);
  const [frames, setFrames] = useState(0);
  const [capturedAt, setCapturedAt] = useState<number>();
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api
      .json<{ frame: null | { data: string; capturedAt: number } }>(
        `/v1/admin/executions/${execution.id}/live-frame`,
        controller.signal,
      )
      .then(({ frame }) => {
        if (
          frame &&
          !controller.signal.aborted &&
          frame.capturedAt >= latestFrameAt.current
        ) {
          latestFrameAt.current = frame.capturedAt;
          setFrame(`data:image/jpeg;base64,${frame.data}`);
          setCapturedAt(frame.capturedAt);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [api, execution.id, active]);
  useEffect(() => {
    if (!active) {
      setState('执行已结束 · 保留最后画面');
      return;
    }
    // 人工接管期间不争用节点画面；恢复 AUTO 后按控制代次重新订阅。
    // 即使轮询错过短暂的人工状态，递增的代次也能使已关闭的连接重建。
    if (execution.control_mode !== 'AUTO') {
      setState('画面已转交人工处理');
      return;
    }
    let disposed = false;
    let ended = false;
    const socket = api.live(execution.id);
    setState('正在连接画面');
    socket.onmessage = (event) => {
      if (disposed) return;
      try {
        const message = JSON.parse(event.data);
        if (
          message.type === 'frame' &&
          typeof message.data === 'string' &&
          message.data.length < 2 * 1024 * 1024 &&
          /^[A-Za-z0-9+/=]+$/.test(message.data)
        ) {
          latestFrameAt.current = message.capturedAt;
          setFrame(`data:image/jpeg;base64,${message.data}`);
          setCapturedAt(message.capturedAt);
          setFrames((n) => n + 1);
          setState('实时画面');
        } else if (message.type === 'state') setCount(message.actionCount);
        else if (message.type === 'ended' || message.type === 'error') {
          ended = true;
          setState(message.reason ?? message.message);
        }
      } catch {
        setState('画面数据无效');
        socket.close();
      }
    };
    socket.onerror = () => {
      if (!disposed) setState('画面连接失败');
    };
    socket.onclose = () => {
      if (!disposed && !ended) setState('画面连接已断开');
    };
    return () => {
      disposed = true;
      socket.close();
    };
  }, [
    api,
    execution.id,
    execution.control_mode,
    execution.control_revision,
    active,
    version,
  ]);
  return (
    <>
      <div className="comparison-browser-bar">
        <span className={active ? 'live-dot' : 'live-dot ended'} />
        <span>
          {handoff
            ? '正在向人工交接画面'
            : human
              ? '画面已转交人工处理'
              : state}
        </span>
        <span className="mono">
          {typeof location !== 'undefined' && location.protocol === 'https:'
            ? 'WSS'
            : 'WS'}
        </span>
      </div>
      <div
        className={`comparison-screen ${!frame && (!active || human) ? 'live-screen-empty' : ''}`}
      >
        {frame ? (
          <img
            src={frame}
            alt={
              human || !active ? '浏览器最后画面（非实时）' : '浏览器实时画面'
            }
          />
        ) : (
          <div className="comparison-placeholder">
            <span aria-hidden="true">▣</span>
            <p>
              {handoff
                ? '正在交接，完成后可从顶部打开独立处理页。'
                : human
                  ? '请点击顶部「去处理」，在独立处理页查看画面并完成待办。'
                  : active
                    ? '等待浏览器首帧…'
                    : '本次会话没有保留实时画面'}
            </p>
          </div>
        )}
      </div>
      <div className="comparison-screen-meta">
        <span>
          已提交 {Math.max(count, execution.action_count)} 次动作 · 接收{' '}
          {frames} 帧
          {capturedAt ? ` · ${new Date(capturedAt).toLocaleTimeString()}` : ''}
        </span>
        {active && execution.control_mode === 'AUTO' && (
          <button
            className="button button-secondary button-small"
            onClick={() => setVersion((v) => v + 1)}
          >
            重新连接画面
          </button>
        )}
      </div>
    </>
  );
}
