import { useEffect, useRef, useState } from 'react';
import type { NodeCommand, HitlServer } from '@proofrun/contracts';
import { ThemeToggle } from '../components/ui';
import { HitlInputQueue } from './hitl-input';
import { HitlCookies } from './hitl-cookies';

/** 完成前包含登录快照落盘，等待窗口应覆盖服务端保存命令和结果确认。 */
const COMPLETION_ACK_MS = 30_000;

/** 当前介入的授权与待办，只通过认证连接获得。 */
interface State {
  /** 当前任务标识，仅用于处理者确认归属。 */
  taskId: string;
  /** Agent 提交的介入原因。 */
  reason: string;
  /** 处理者逐项确认的待办。 */
  items: string[];
  /** REQUESTED 等待交接，HUMAN 才允许输入。 */
  mode: string;
  /** 本轮操作授权的截止时间。 */
  expiresAt: string;
  /** 仅绑定登录槽的任务可显式保存登录状态。 */
  canSaveAuth: boolean;
  /** 旧服务端未返回目标地址时不显示 Cookie 表单。 */
  targetUrl?: string;
}
/** 允许直接转发的非文本按键，其余文字短暂合并后提交。 */
const KEYS = new Set([
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
]);

/** 免平台登录的独立入口；凭据仅通过 WebSocket 首帧发送。 */
export function HitlPage({ id, token }: { id: string; token: string }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>();
  const [authResult, setAuthResult] = useState('');
  const [frame, setFrame] = useState<{
    data: string;
    width: number;
    height: number;
  }>();
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<number[]>([]);
  const [text, setText] = useState('');
  const socket = useRef<WebSocket | null>(null);
  const completionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const input = useRef<HitlInputQueue | null>(null);
  if (!input.current)
    input.current = new HitlInputQueue(
      (item) => {
        if (socket.current?.readyState !== WebSocket.OPEN) return false;
        socket.current.send(JSON.stringify({ type: 'command', ...item }));
        return true;
      },
      setBusy,
      () => {
        setError(
          '操作结果未确认，已停止后续操作。请重新连接检查页面，不要重复提交。',
        );
        setConnected(false);
        socket.current?.close();
      },
    );
  const completed = useRef(false);
  const completing = useRef(false);
  const typing = useRef('');
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [typingPending, setTypingPending] = useState(false);
  /** 区分交接、断线和队列繁忙，避免让短暂拥塞看起来像权限丢失。 */
  const enqueue = (command: NodeCommand['command']) => {
    if (!connected || state?.mode !== 'HUMAN' || completing.current) {
      setError('当前未获得操作权，请等待交接完成或重新连接');
      return false;
    }
    setError('');
    if (!input.current!.enqueue(command)) {
      setError('操作队列已满，请等待已提交操作完成');
      return false;
    }
    return true;
  };
  /** 派发短暂合并的文字，保证后续点击和按键不会越过输入。 */
  const flush = () => {
    clearTimeout(typingTimer.current);
    const value = typing.current;
    typing.current = '';
    setTypingPending(false);
    if (value) enqueue({ type: 'browser.input', action: 'text', value });
  };
  useEffect(() => {
    completed.current = false;
    completing.current = false;
    input.current!.reset();
    clearTimeout(completionTimer.current);
    setConnected(false);
    setBusy(false);
    setError('');
    setFrame(undefined);
    const url = new URL('/v1/hitl/connect', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    socket.current = ws;
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: 'authenticate', id, token }));
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data) as HitlServer;
      if (message.type === 'state') {
        setState(message);
        setConnected(true);
      } else if (message.type === 'frame')
        setFrame({
          data: message.data,
          width: message.width,
          height: message.height,
        });
      else if (message.type === 'error') {
        setError(message.message);
        input.current!.reset();
        clearTimeout(completionTimer.current);
        setBusy(false);
        completing.current = false;
      } else if (message.type === 'result') {
        if (input.current!.acknowledge(message)) setError('');
      } else if (message.type === 'completed') {
        setAuthResult(
          message.authStatus === 'saved'
            ? '登录状态已保存，下次任务可复用。'
            : message.authStatus === 'newer'
              ? '已保留其他会话更新的登录状态。'
              : '',
        );
        completed.current = true;
        setDone(true);
        setConnected(false);
        setFrame(undefined);
        setText('');
        setError('');
        input.current!.reset();
        clearTimeout(completionTimer.current);
        ws.close();
        // 脚本打开的处理 tab 可自动关闭；浏览器禁止关闭时保留明确的完成页。
        window.close();
      }
    };
    ws.onclose = () => {
      const hadPendingInput = input.current!.busy;
      setConnected(false);
      setFrame(undefined);
      setText('');
      clearTimeout(typingTimer.current);
      typing.current = '';
      setTypingPending(false);
      if (!completed.current)
        setError(
          (previous) =>
            previous ||
            (hadPendingInput
              ? '连接中断，操作结果未确认；重新连接后先检查页面。'
              : '连接已断开。关闭此页不会自动恢复 Agent。'),
        );
      input.current!.reset();
      clearTimeout(completionTimer.current);
      setBusy(false);
      completing.current = false;
    };
    ws.onerror = () => setError('无法连接处理服务，请检查网络后重新连接');
    return () => {
      ws.onopen = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.onmessage = null;
      ws.close();
      input.current!.reset();
      clearTimeout(completionTimer.current);
      clearTimeout(typingTimer.current);
      typing.current = '';
    };
  }, [id, token, attempt]);
  const interactive = connected && state?.mode === 'HUMAN' && !!frame && !done;
  return (
    <main className="hitl-page">
      <header className="hitl-header">
        <span className="brand">ProofRun.</span>
        <span>人工处理</span>
        <ThemeToggle />
      </header>
      {done ? (
        <section className="panel hitl-done">
          <h1>处理已完成</h1>
          <p>浏览器已交还 Agent。{authResult}可以关闭此页。</p>
          <button
            className="button button-primary"
            onClick={() => window.close()}
          >
            关闭页面
          </button>
        </section>
      ) : (
        <div className="hitl-layout">
          <aside className="panel hitl-todo">
            <p className="eyebrow">当前待办</p>
            <h1>{state?.reason ?? '正在连接处理任务'}</h1>
            {state && (
              <>
                <p className="muted">任务 {state.taskId}</p>
                <p className="note">
                  有效至 {new Date(state.expiresAt).toLocaleString()}
                  ，等待时间计入任务预算。
                </p>
                <div className="hitl-checks">
                  {state.items.map((item, index) => (
                    <label key={index}>
                      <input
                        type="checkbox"
                        checked={checked.includes(index)}
                        onChange={(event) =>
                          setChecked((values) =>
                            event.target.checked
                              ? [...values, index]
                              : values.filter((v) => v !== index),
                          )
                        }
                      />
                      <span>{item}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
            <p role="status">
              {connected
                ? state?.mode === 'HUMAN'
                  ? '人工处理中'
                  : '正在等待 Agent 完成交接…'
                : '未连接'}
            </p>
            {error && (
              <p role="alert" className="error-notice">
                {error}
              </p>
            )}
            {!connected && (
              <button
                className="button button-secondary"
                onClick={() => setAttempt((n) => n + 1)}
              >
                重新连接
              </button>
            )}
            <button
              className="button button-primary"
              disabled={
                !interactive ||
                busy ||
                typingPending ||
                checked.length !== state?.items.length
              }
              onClick={() => {
                completing.current = true;
                setBusy(true);
                socket.current?.send(JSON.stringify({ type: 'complete' }));
                completionTimer.current = setTimeout(() => {
                  setError('交接结果未确认，请重新连接查看处理状态。');
                  setConnected(false);
                  socket.current?.close();
                }, COMPLETION_ACK_MS);
              }}
            >
              {state?.canSaveAuth ? '保存登录状态并继续任务' : '完成，继续任务'}
            </button>
            <p className="muted note">
              {state?.canSaveAuth &&
                '完成时保存登录状态；其他会话已更新时保留较新的快照。'}
              完成后自动关闭此页。直接离开只会断开画面，任务继续等待人工处理。
            </p>
          </aside>
          <section className="panel hitl-browser" aria-label="当前任务浏览器">
            <div className="section-heading">
              <h2>当前浏览器</h2>
              <span className="status">
                {busy ? '操作处理中' : interactive ? '可操作' : '等待画面'}
              </span>
            </div>
            {frame ? (
              <img
                className="hitl-screen"
                alt="当前任务的实时浏览器画面，点击后可输入"
                src={`data:image/jpeg;base64,${frame.data}`}
                tabIndex={0}
                onClick={(event) => {
                  if (!interactive) return;
                  flush();
                  event.currentTarget.focus();
                  const r = event.currentTarget.getBoundingClientRect();
                  enqueue({
                    type: 'browser.input',
                    action: 'click',
                    x: ((event.clientX - r.left) * frame.width) / r.width,
                    y: ((event.clientY - r.top) * frame.height) / r.height,
                  });
                }}
                onWheel={(event) => {
                  if (!interactive) return;
                  flush();
                  const r = event.currentTarget.getBoundingClientRect();
                  enqueue({
                    type: 'browser.input',
                    action: 'scroll',
                    x: ((event.clientX - r.left) * frame.width) / r.width,
                    y: ((event.clientY - r.top) * frame.height) / r.height,
                    deltaX: Math.max(
                      -2000,
                      Math.min(2000, Math.round(event.deltaX)),
                    ),
                    deltaY: Math.max(
                      -2000,
                      Math.min(2000, Math.round(event.deltaY)),
                    ),
                  });
                }}
                onKeyDown={(event) => {
                  if (!interactive || event.nativeEvent.isComposing) return;
                  if (
                    KEYS.has(event.key) ||
                    ((event.ctrlKey || event.metaKey) &&
                      event.key.toLowerCase() === 'a')
                  ) {
                    event.preventDefault();
                    flush();
                    enqueue({
                      type: 'browser.input',
                      action: 'press',
                      // 处理者可能使用 macOS，远端节点固定运行 Linux。
                      value:
                        (event.ctrlKey || event.metaKey) &&
                        event.key.toLowerCase() === 'a'
                          ? 'Control+a'
                          : event.shiftKey && event.key === 'Tab'
                            ? 'Shift+Tab'
                            : event.key,
                    });
                  } else if (
                    event.key.length === 1 &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.altKey
                  ) {
                    event.preventDefault();
                    if (event.key === '-' && !typing.current) {
                      flush();
                      enqueue({
                        type: 'browser.input',
                        action: 'press',
                        value: 'Minus',
                      });
                      return;
                    }
                    typing.current += event.key;
                    setTypingPending(true);
                    clearTimeout(typingTimer.current);
                    typingTimer.current = setTimeout(flush, 250);
                  }
                }}
              />
            ) : (
              <div className="hitl-placeholder">
                {state?.mode === 'REQUESTED'
                  ? 'Agent 正在完成当前操作，请稍候。'
                  : '等待浏览器画面…'}
              </div>
            )}
            <form
              className="control-form"
              onSubmit={(event) => {
                event.preventDefault();
                flush();
                if (
                  enqueue({
                    type: 'browser.input',
                    action: 'text',
                    value: text,
                  })
                )
                  setText('');
              }}
            >
              <label>
                向远端焦点输入文字（支持中文与粘贴）
                <input
                  type="password"
                  autoComplete="off"
                  value={text}
                  maxLength={4096}
                  onChange={(event) => setText(event.target.value)}
                  disabled={!interactive}
                />
              </label>
              <button
                className="button button-secondary"
                disabled={!interactive || !text}
              >
                输入
              </button>
            </form>
            {state?.targetUrl && (
              <HitlCookies
                targetUrl={state.targetUrl}
                disabled={!interactive || busy || typingPending}
                submit={enqueue}
              />
            )}
            <div className="page-actions">
              {['Tab', 'Enter', 'Backspace', 'Escape'].map((key) => (
                <button
                  key={key}
                  className="button button-secondary button-small"
                  disabled={!interactive}
                  onClick={() => {
                    flush();
                    enqueue({
                      type: 'browser.input',
                      action: 'press',
                      value: key,
                    });
                  }}
                >
                  {key}
                </button>
              ))}
              {state?.canSaveAuth && (
                <button
                  className="button button-secondary button-small"
                  disabled={!interactive || busy}
                  onClick={() => {
                    flush();
                    enqueue({ type: 'browser.auth.save' });
                  }}
                >
                  保存登录状态
                </button>
              )}
            </div>
            <p className="muted note">
              可直接点击画面、输入和滚动；中文可使用下方输入框。输入内容不会显示在操作摘要中。
            </p>
          </section>
        </div>
      )}
    </main>
  );
}
