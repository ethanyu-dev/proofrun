import { HitlConnection, type ConnectionState } from './hitl-connection';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { useEffect, useRef, useState } from 'react';
import type { NodeCommand, HitlServer } from '@proofrun/contracts';
import { ThemeToggle } from '../components/ui';
import { HitlInputQueue, type BatchResult } from './hitl-input';
import { screenPoint, useHitlScreen } from './hitl-screen';
import { HitlNavigation, remainingTime } from './hitl-navigation';
import { HitlCookies } from './hitl-cookies';

/** 等待控制权交还确认；超时后通过重连核查，避免重复提交。 */
const COMPLETION_ACK_MS = 150_000;
/** 首帧超时只提示恢复入口，不撤销控制权或重放已提交的操作。 */
const FIRST_FRAME_MS = 10_000;

/** 当前介入的授权与待办，只通过认证连接获得。 */
interface State {
  /** 当前任务标识，仅用于处理者确认归属。 */
  taskId: string;
  /** Agent 提交的介入原因。 */
  reason: string;
  /** 处理者逐项确认的待办。 */
  items: string[];
  /** 与本轮待办一一对应的稳定身份，旧服务端可缺省。 */
  conditionKeys?: string[];
  /** REQUESTED 等待交接，HUMAN 才允许输入。 */
  mode: string;
  /** 本轮操作授权的截止时间。 */
  expiresAt: string;
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

/** 人工处理当前任务的临时浏览器，确认后交还 Agent。 */
export function HitlPage({ id, token }: { id: string; token?: string }) {
  const [remoteFocused, setRemoteFocused] = useState(false);
  const [now, setNow] = useState(Date.now);
  const screen = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>();
  const [unable, setUnable] = useState(false);
  const [unableReason, setUnableReason] = useState('');
  const [unableResult, setUnableResult] = useState('');
  const [frame, setFrame] = useState<{
    data: string;
    width: number;
    height: number;
  }>();
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('connecting');
  // 重连期间保留最后一帧供核对，但只有本轮新帧才能恢复坐标输入。
  const [freshFrame, setFreshFrame] = useState(false);
  const [frameTimedOut, setFrameTimedOut] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    setFrame(undefined);
    setState(undefined);
    setChecked([]);
    setDone(false);
    setUnableResult('');
  }, [id, token]);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<number[]>([]);
  const [text, setText] = useState('');
  const socket = useRef<HitlConnection | null>(null);
  const completionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const input = useRef<HitlInputQueue | null>(null);
  if (!input.current)
    input.current = new HitlInputQueue(
      (item) => {
        if (socket.current?.readyState !== WebSocket.OPEN) return false;
        // 输入可能改变认证环境，必须在操作完成后重新勾选；纯滚动不清空。
        if (
          (item.command.type === 'browser.input' &&
            item.command.action !== 'scroll') ||
          item.command.type === 'browser.act' ||
          item.command.type === 'browser.cookies.set'
        )
          setChecked([]);
        socket.current.send(
          JSON.stringify({
            type: 'command',
            commandId: item.commandId,
            command: item.command,
          }),
        );
        return true;
      },
      setBusy,
      () =>
        stopForReview(
          '操作结果未确认，已停止后续操作。请重新连接检查页面，不要重复提交。',
        ),
    );
  const completed = useRef(false);
  const completing = useRef(false);
  const typing = useRef('');
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const [typingPending, setTypingPending] = useState(false);
  /** 操作或交接结果不明时停止输入并开放手动核查，不能让 busy 锁住恢复入口。 */
  function stopForReview(message: string) {
    socket.current?.close();
    if (input.current!.busy) input.current!.reset();
    clearTimeout(completionTimer.current);
    clearTimeout(typingTimer.current);
    typing.current = '';
    completing.current = false;
    setTypingPending(false);
    setBusy(false);
    setConnected(false);
    setFreshFrame(false);
    setRemoteFocused(false);
    setConnectionState('closed');
    setError(message);
  }
  /** 区分交接、断线和队列繁忙，避免让短暂拥塞看起来像权限丢失。 */
  const enqueue = (
    command: NodeCommand['command'] | NodeCommand['command'][],
    settled?: (result: BatchResult) => void,
  ) => {
    if (!connected || state?.mode !== 'HUMAN' || completing.current) {
      setError('当前未获得操作权，请等待交接完成或重新连接');
      return false;
    }
    setError('');
    if (
      !(Array.isArray(command)
        ? input.current!.enqueueBatch(command, settled)
        : input.current!.enqueue(command))
    ) {
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
    setRemoteFocused(false);
    setBusy(false);
    setError('');
    setFreshFrame(false);
    const ws = new HitlConnection({
      id: id ?? '',
      token: token ?? '',
      message: (message) => {
        if (message.type === 'state') {
          setState(message);
          setConnected(true);
          if (message.finalizing) {
            completing.current = true;
            setBusy(true);
          }
        } else if (message.type === 'frame') {
          setFreshFrame(true);
          setFrame({
            data: message.data,
            width: message.width,
            height: message.height,
          });
        } else if (message.type === 'error') {
          setError(message.message);
          input.current!.reset();
          clearTimeout(completionTimer.current);
          setBusy(false);
          completing.current = false;
        } else if (message.type === 'result') {
          if (input.current!.acknowledge(message)) setError('');
        } else if (message.type === 'unable') {
          completed.current = true;
          completing.current = false;
          setUnableResult(message.reason);
          setDone(true);
          setConnected(false);
          setFrame(undefined);
          setText('');
          setError('');
          input.current!.reset();
          clearTimeout(completionTimer.current);
          ws.close();
        } else if (message.type === 'completed') {
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
      },
      closed: () => {
        const hadPendingInput = input.current!.busy;
        setConnected(false);
        setFreshFrame(false);
        setRemoteFocused(false);
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
      },
      error: setError,
      status: setConnectionState,
    });
    socket.current = ws;
    return () => {
      ws.close();
      input.current!.reset();
      clearTimeout(completionTimer.current);
      clearTimeout(typingTimer.current);
      typing.current = '';
    };
  }, [id, token, attempt]);
  const hasFrame = !!frame && freshFrame;
  useEffect(() => {
    setFrameTimedOut(false);
    if (!connected || state?.mode !== 'HUMAN' || hasFrame || done) return;
    const timer = setTimeout(() => setFrameTimedOut(true), FIRST_FRAME_MS);
    return () => clearTimeout(timer);
  }, [connected, state?.mode, hasFrame, done, attempt]);
  const expired = !!state && Date.parse(state.expiresAt) <= now;
  // 导航不依赖画面坐标；仅坐标输入要求首帧，避免空白页无法导航的闭环。
  const authorized = connected && state?.mode === 'HUMAN' && !done && !expired;
  const interactive = authorized && hasFrame;
  const controlling = interactive && remoteFocused;
  useHitlScreen({
    screen,
    interactive,
    width: frame?.width ?? 0,
    height: frame?.height ?? 0,
    flush,
    submit: enqueue,
    release: () => setRemoteFocused(false),
  });
  return (
    <main className="hitl-page">
      {done ? (
        <section className="panel hitl-done">
          <h1>{unableResult ? '人为判定无法执行' : '处理已完成'}</h1>
          <p>{unableResult || '浏览器已交还 Agent，可以关闭此页。'}</p>
          <Button
            variant="default"
            className="button button-primary"
            onClick={() => {
              window.close();
            }}
          >
            关闭页面
          </Button>
        </section>
      ) : (
        <div className="hitl-layout">
          <section className="hitl-browser" aria-label="当前任务浏览器">
            {frame ? (
              <img
                ref={screen}
                className="hitl-screen"
                aria-disabled={!interactive}
                onFocus={() => setRemoteFocused(true)}
                onBlur={() => {
                  flush();
                  setRemoteFocused(false);
                }}
                alt="当前任务的实时浏览器画面，点击后可输入"
                src={`data:image/jpeg;base64,${frame.data}`}
                tabIndex={interactive ? 0 : -1}
                onClick={(event) => {
                  if (!interactive) return;
                  flush();
                  event.currentTarget.focus({ preventScroll: true });
                  const r = event.currentTarget.getBoundingClientRect();
                  enqueue({
                    type: 'browser.input',
                    action: 'click',
                    ...screenPoint(
                      event.clientX,
                      event.clientY,
                      r,
                      frame.width,
                      frame.height,
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
              <div className="hitl-placeholder" role="status">
                {connectionState === 'reconnecting'
                  ? '连接已断开，正在重新连接…'
                  : connectionState === 'closed'
                    ? '连接已断开，请重新连接。'
                    : state?.mode === 'REQUESTED'
                      ? 'Agent 正在完成当前操作，请稍候。'
                      : frameTimedOut
                        ? '浏览器画面加载超时。可先前往目标网址，或重新连接画面。'
                        : '等待浏览器画面…'}
              </div>
            )}
            {frame && !freshFrame && (
              <div className="hitl-stale" role="status">
                上次画面 ·{' '}
                {connectionState === 'closed'
                  ? '已断开，请重新连接'
                  : '正在恢复连接'}
              </div>
            )}
          </section>
          <div className="hitl-toolbar">
            <span className="brand">ProofRun.</span>
            <span className="status">
              {expired
                ? '处理已到期'
                : busy
                  ? '操作处理中'
                  : interactive
                    ? '人工处理中'
                    : connectionState === 'reconnecting'
                      ? '正在重连'
                      : connectionState === 'closed'
                        ? '已断开'
                        : '等待连接'}
            </span>
            <span className="hitl-focus-hint" role="status">
              {controlling
                ? '● 已聚焦浏览器 · 键盘和滚轮仅作用于远端'
                : '点击画面聚焦浏览器，点击画面外退出'}
            </span>
            <Button
              variant="outline"
              type="button"
              className="button button-small button-secondary"
              disabled={!controlling}
              onClick={() => {
                screen.current?.blur();
                setRemoteFocused(false);
              }}
            >
              退出聚焦
            </Button>
            <ThemeToggle />
          </div>
          <div className="hitl-controls">
            <section className="panel hitl-tools" aria-label="浏览器操作">
              <h2>浏览器操作</h2>
              <HitlNavigation
                key={state?.targetUrl}
                targetUrl={state?.targetUrl}
                disabled={!authorized || busy || typingPending}
                submit={enqueue}
              />
              <form
                className="control-form hitl-text-input"
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
                  <Input
                    type="password"
                    autoComplete="off"
                    value={text}
                    maxLength={4096}
                    onChange={(event) => setText(event.target.value)}
                    disabled={!interactive}
                  />
                </label>
                <Button
                  variant="outline"
                  className="button button-secondary"
                  disabled={!interactive || !text}
                >
                  输入
                </Button>
              </form>
              <div className="page-actions hitl-keys">
                {['Tab', 'Enter', 'Backspace', 'Escape'].map((key) => (
                  <Button
                    variant="outline"
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
                  </Button>
                ))}
              </div>
              <p className="muted note">
                点击画面操作；中文与粘贴可使用输入框。
              </p>
              {state?.targetUrl && (
                <details className="hitl-cookie-disclosure">
                  <summary>通过 Cookie 登录</summary>
                  <HitlCookies
                    targetUrl={state.targetUrl}
                    disabled={!interactive || busy || typingPending}
                    submit={enqueue}
                  />
                </details>
              )}
            </section>
            <aside className="panel hitl-todo">
              <h1>当前待办</h1>
              <details className="hitl-reason">
                <summary>查看介入原因</summary>
                <p>{state?.reason ?? '正在连接处理任务'}</p>
              </details>
              {state && (
                <>
                  <p className="muted hitl-task-id">任务 {state.taskId}</p>
                  <p className="note">
                    有效至 {new Date(state.expiresAt).toLocaleString()}
                    。完成后继续执行任务。
                    <strong
                      className={
                        Date.parse(state.expiresAt) - now <= 60000
                          ? 'hitl-time-warning'
                          : 'hitl-time'
                      }
                    >
                      处理链接剩余有效期：{remainingTime(state.expiresAt, now)}
                    </strong>
                  </p>
                  <div className="hitl-checks">
                    {state.items.map((item, index) => (
                      <label key={index}>
                        <Input
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
              <p role="status" className="hitl-connection-status">
                {connected
                  ? state?.mode === 'HUMAN'
                    ? '人工处理中'
                    : '正在等待 Agent 完成交接…'
                  : connectionState === 'reconnecting'
                    ? '正在自动重连…'
                    : '未连接'}
              </p>
              {error && (
                <p role="alert" className="error-notice">
                  {error}
                </p>
              )}
              {(!connected || !hasFrame || frameTimedOut) && (
                <Button
                  variant="outline"
                  className="button button-secondary"
                  disabled={busy || typingPending || completing.current}
                  onClick={() => setAttempt((n) => n + 1)}
                >
                  重新连接
                </Button>
              )}
              <div className="hitl-finish-actions">
                <Button
                  variant="default"
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
                    socket.current?.send(
                      JSON.stringify({
                        type: 'complete',
                        confirmedItems: checked,
                        ...(state?.conditionKeys
                          ? {
                              confirmedConditionKeys: checked.map(
                                (index) => state.conditionKeys![index]!,
                              ),
                            }
                          : {}),
                      }),
                    );
                    completionTimer.current = setTimeout(() => {
                      stopForReview('交接结果未确认，请重新连接查看处理状态。');
                    }, COMPLETION_ACK_MS);
                  }}
                >
                  完成，继续任务
                </Button>
                <Button
                  variant="outline"
                  className="button button-secondary"
                  disabled={
                    !connected ||
                    state?.mode !== 'HUMAN' ||
                    busy ||
                    typingPending ||
                    expired
                  }
                  onClick={() => setUnable((value) => !value)}
                >
                  无法处理
                </Button>
              </div>
              {unable && (
                <div className="identity-field">
                  <label htmlFor="unable-reason">无法处理的具体原因</label>
                  <Textarea
                    id="unable-reason"
                    required
                    rows={3}
                    maxLength={2000}
                    value={unableReason}
                    onChange={(event) => setUnableReason(event.target.value)}
                    placeholder="例如：无法取得符合要求的团队权限"
                  />
                  <Button
                    variant="default"
                    className="button button-primary"
                    disabled={
                      !connected ||
                      state?.mode !== 'HUMAN' ||
                      busy ||
                      typingPending ||
                      expired ||
                      !unableReason.trim()
                    }
                    onClick={() => {
                      completing.current = true;
                      setBusy(true);
                      socket.current?.send(
                        JSON.stringify({
                          type: 'unable',
                          reason: unableReason.trim(),
                        }),
                      );
                      completionTimer.current = setTimeout(() => {
                        stopForReview(
                          '结果未确认，请重新连接核查人工处理结果。',
                        );
                      }, COMPLETION_ACK_MS);
                    }}
                  >
                    确认无法执行
                  </Button>
                </div>
              )}
              <p className="muted note">
                完成后自动关闭。离开页面不会恢复
                Agent；到期后请从任务页重新打开。
              </p>
            </aside>
          </div>
        </div>
      )}
    </main>
  );
}
