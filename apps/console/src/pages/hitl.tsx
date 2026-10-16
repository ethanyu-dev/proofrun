import { useEffect, useRef, useState } from 'react';
import type { NodeCommand, HitlServer } from '@proofrun/contracts';
import { ThemeToggle } from '../components/ui';
import { HitlInputQueue, type BatchResult } from './hitl-input';
import { screenPoint, useHitlScreen } from './hitl-screen';
import { HitlNavigation, remainingTime } from './hitl-navigation';
import { HitlCookies } from './hitl-cookies';
import type { ApiClient } from '../api';

/** 完成前包含登录快照落盘，等待窗口应覆盖服务端保存命令和结果确认。 */
const COMPLETION_ACK_MS = 150_000;

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

/** 共用人工操作界面；任务入口使用专属令牌，节点模板入口使用 Console 会话。 */
export function HitlPage({
  id,
  token,
  api,
}: {
  id: string;
  token?: string;
  api?: ApiClient;
}) {
  const nodeProfile = !!api;
  // Console 已有主内容容器，复用界面时不嵌套 main 地标。
  const Container = nodeProfile ? 'section' : 'main';
  const [remoteFocused, setRemoteFocused] = useState(false);
  const [now, setNow] = useState(Date.now);
  const screen = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State>();
  const [authResult, setAuthResult] = useState('');
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
        // 输入可能改变认证环境，必须在操作完成后重新勾选；纯滚动与保存不清空。
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
    setFrame(undefined);
    const url = new URL('/v1/hitl/connect', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = api ? api.nodeProfile(id) : new WebSocket(url);
    socket.current = ws;
    if (!api)
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
        setAuthResult(
          nodeProfile
            ? message.authStatus === 'saved'
              ? '节点默认 profile 已保存，浏览器已关闭。'
              : message.authStatus === 'newer'
                ? '已保留较新的节点默认 profile，浏览器已关闭。'
                : '浏览器已关闭。'
            : message.authStatus === 'saved'
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
        if (!nodeProfile) window.close();
      }
    };
    ws.onclose = () => {
      const hadPendingInput = input.current!.busy;
      setConnected(false);
      setFrame(undefined);
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
              : nodeProfile
                ? '连接已断开，请重新连接。维护会话到期后会自动关闭。'
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
  }, [id, token, api, nodeProfile, attempt]);
  const expired = !!state && Date.parse(state.expiresAt) <= now;
  const interactive =
    connected && state?.mode === 'HUMAN' && !!frame && !done && !expired;
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
    <Container className="hitl-page">
      {done ? (
        <section className="panel hitl-done">
          <h1>{unableResult ? '人为判定无法执行' : '处理已完成'}</h1>
          <p>
            {nodeProfile
              ? authResult
              : unableResult ||
                `浏览器已交还 Agent。${authResult}可以关闭此页。`}
          </p>
          <button
            className="button button-primary"
            onClick={() => {
              if (nodeProfile) location.hash = '/nodes';
              else window.close();
            }}
          >
            {nodeProfile ? '返回节点管理' : '关闭页面'}
          </button>
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
              <div className="hitl-placeholder">
                {state?.mode === 'REQUESTED'
                  ? 'Agent 正在完成当前操作，请稍候。'
                  : '等待浏览器画面…'}
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
                    : '等待连接'}
            </span>
            <span className="hitl-focus-hint" role="status">
              {controlling
                ? '● 已聚焦浏览器 · 键盘和滚轮仅作用于远端'
                : '点击画面聚焦浏览器，点击画面外退出'}
            </span>
            <button
              type="button"
              className="button button-small button-secondary"
              disabled={!controlling}
              onClick={() => {
                screen.current?.blur();
                setRemoteFocused(false);
              }}
            >
              退出聚焦
            </button>
            <ThemeToggle />
          </div>
          <div className="hitl-controls">
            <section className="panel hitl-tools" aria-label="浏览器操作">
              {state?.targetUrl && (
                <HitlCookies
                  targetUrl={state.targetUrl}
                  disabled={!interactive || busy || typingPending}
                  submit={enqueue}
                />
              )}
              <h2>浏览器操作</h2>
              <HitlNavigation
                key={state?.targetUrl}
                targetUrl={state?.targetUrl}
                disabled={!interactive || busy || typingPending}
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
              </div>
              <p className="muted note">
                可直接点击画面、输入和滚动；中文可使用下方输入框。输入内容不会显示在操作摘要中。
              </p>
            </section>
            <aside className="panel hitl-todo">
              <p className="eyebrow">当前待办</p>
              <h1>{state?.reason ?? '正在连接处理任务'}</h1>
              {state && (
                <>
                  {!nodeProfile && <p className="muted">任务 {state.taskId}</p>}
                  <p className="note">
                    有效至 {new Date(state.expiresAt).toLocaleString()}
                    {nodeProfile
                      ? '，到期后自动关闭；保存后供该节点后续新身份使用。'
                      : '，业务步骤的人工等待不计时，完成后继续执行；后续清理仍受三分钟期限约束。'}
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
              {nodeProfile && !connected && (
                <button
                  className="button button-secondary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api!.json(
                        `/v1/node-profiles/${id}/close`,
                        new AbortController().signal,
                        {},
                      );
                      location.reload();
                    } catch {
                      setError('关闭结果未确认，请返回节点管理查看会话状态。');
                      setBusy(false);
                    }
                  }}
                >
                  关闭维护会话
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
                    setError('交接结果未确认，请重新连接查看处理状态。');
                    setConnected(false);
                    socket.current?.close();
                  }, COMPLETION_ACK_MS);
                }}
              >
                {nodeProfile
                  ? '保存并关闭'
                  : state?.canSaveAuth
                    ? '处理完成，保存基准并继续'
                    : '完成，继续任务'}
              </button>
              <button
                className="button button-secondary"
                disabled={
                  !connected ||
                  state?.mode !== 'HUMAN' ||
                  busy ||
                  typingPending ||
                  expired
                }
                onClick={() => {
                  if (!nodeProfile) {
                    setUnable((value) => !value);
                    return;
                  }
                  completing.current = true;
                  setBusy(true);
                  socket.current?.send(
                    JSON.stringify({
                      type: 'unable',
                      reason: '不保存并关闭节点模板维护会话',
                    }),
                  );
                  completionTimer.current = setTimeout(() => {
                    setError('关闭结果未确认，请重新连接查看状态。');
                    socket.current?.close();
                  }, COMPLETION_ACK_MS);
                }}
              >
                {nodeProfile ? '不保存并关闭' : '无法处理'}
              </button>
              {unable && (
                <div className="identity-field">
                  <label htmlFor="unable-reason">无法处理的具体原因</label>
                  <textarea
                    id="unable-reason"
                    required
                    rows={3}
                    maxLength={2000}
                    value={unableReason}
                    onChange={(event) => setUnableReason(event.target.value)}
                    placeholder="例如：无法取得符合要求的团队权限"
                  />
                  <button
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
                        setError('结果未确认，请重新连接核查人工处理结果。');
                        setConnected(false);
                        socket.current?.close();
                      }, COMPLETION_ACK_MS);
                    }}
                  >
                    确认无法执行
                  </button>
                </div>
              )}
              <p className="muted note">
                {nodeProfile ? (
                  '保存会更新该节点的默认模板，已有身份基准不受影响。直接离开只断开画面，可从节点管理继续；会话到期后自动关闭且不保存。'
                ) : (
                  <>
                    {state?.canSaveAuth &&
                      '处理成功后保存浏览器基准，浏览器可能短暂重启；无法处理时不保存。'}
                    完成后自动关闭此页。直接离开只会断开画面，任务继续等待人工处理。链接过期后请从任务详情重新打开处理页。
                  </>
                )}
              </p>
            </aside>
          </div>
        </div>
      )}
    </Container>
  );
}
