import { StrictMode, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiClient, errorMessage } from './api';
import { Empty, ErrorNotice, ThemeToggle } from './components/ui';
import { TaskListPage } from './pages/task-list';
import { TaskDetailPage } from './pages/task-detail';
import { TaskSubmitPage } from './pages/task-submit';
import { NodesPage } from './pages/nodes';
import { HitlPage } from './pages/hitl';
import {
  readSavedCredential,
  saveCredential,
  clearSavedCredential,
} from './credential-storage';
import './tokens.css';
import './style.css';

/** 路由只接受协议允许的任务身份，未知路径显示明确的缺失页面。 */
const TASK_ROUTE = /^\/tasks\/([A-Za-z0-9_-]{1,128})$/;
const NAVIGATION = [
  ['/tasks', '验证任务'],
  ['/nodes', '执行节点'],
  ['/reports', '证据报告'],
];

/** 重新进入时自动填入本地凭据；仍由用户点击连接，验证成功后才更新保存值。 */
function Connect({
  onConnect,
}: {
  onConnect: (api: ApiClient, saved: boolean) => void;
}) {
  const [token, setToken] = useState(readSavedCredential);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError(undefined);
    const api = new ApiClient(token.trim());
    try {
      await api.json('/v1/tasks?limit=1', controller.signal);
      if (!controller.signal.aborted)
        onConnect(api, saveCredential(token.trim()));
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };
  return (
    <section className="connect-page">
      <p className="announcement">ProofRun · 浏览器验证执行平台</p>
      <h1>
        让每一次验证，
        <br />
        都有据可查。
      </h1>
      <p className="muted">连接控制面，查看任务、节点和证据报告。</p>
      <form className="panel connect-form" onSubmit={connect}>
        <label htmlFor="admin-token">访问凭据</label>
        <input
          id="admin-token"
          type="password"
          autoComplete="off"
          value={token}
          maxLength={512}
          onChange={(event) => setToken(event.target.value)}
          required
          disabled={pending}
        />
        <p className="muted note">
          连接成功后，凭据会保存在此浏览器。再次打开或断开连接后自动填入。
        </p>
        <ErrorNotice message={error} />
        <button
          className="button button-primary"
          disabled={pending || !token.trim()}
        >
          {pending ? '连接中…' : '连接控制面'} <span aria-hidden="true">↗</span>
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={pending}
          onClick={() => {
            if (clearSavedCredential()) {
              setToken('');
              setError(undefined);
            } else {
              setError(
                '浏览器无法清除已保存的凭据，请在站点设置中清除本地数据。',
              );
            }
          }}
        >
          清除已保存凭据
        </button>
      </form>
    </section>
  );
}

/** 仅使用页内路由与页面级读取，不引入第二份任务状态或调度器。 */
function App() {
  const [api, setApi] = useState<ApiClient | null>(null);
  /** 本地保存失败不阻断已验证的连接，但明确提示本次不能记住凭据。 */
  const [storageNotice, setStorageNotice] = useState<string>();
  const [path, setPath] = useState(() => location.hash.slice(1) || '/tasks');
  useEffect(() => {
    const changed = () => {
      setPath(location.hash.slice(1) || '/tasks');
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  const hitl = /^\/hitl\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{32,256})$/.exec(
    path,
  );
  if (hitl) return <HitlPage key={hitl[1]} id={hitl[1]!} token={hitl[2]!} />;
  if (path.startsWith('/hitl'))
    return (
      <main className="hitl-page">
        <section className="panel hitl-done">
          <h1>处理链接无效</h1>
          <p>请使用本次任务的完整处理链接。</p>
        </section>
      </main>
    );
  const taskId = TASK_ROUTE.exec(path)?.[1];
  let page;
  if (!api)
    page = (
      <Connect
        onConnect={(client, saved) => {
          setStorageNotice(
            saved
              ? undefined
              : '已连接，但浏览器未允许保存凭据；再次打开时需要重新输入。',
          );
          setApi(client);
        }}
      />
    );
  else if (path === '/tasks' || path === '/reports')
    page = <TaskListPage key={path} api={api} reports={path === '/reports'} />;
  else if (path === '/tasks/new') page = <TaskSubmitPage api={api} />;
  else if (taskId) page = <TaskDetailPage key={taskId} api={api} id={taskId} />;
  else if (path === '/nodes') page = <NodesPage api={api} />;
  else
    page = (
      <Empty title="页面不存在">
        <a href="#/tasks">返回任务列表</a>
      </Empty>
    );
  return (
    <>
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        跳到主要内容
      </a>
      <header className="site-header">
        <nav className="site-nav" aria-label="主导航">
          <a className="brand" href="#/tasks">
            ProofRun.
          </a>
          <div className="nav-links">
            {NAVIGATION.map(([href, label]) => (
              <a
                href={`#${href}`}
                key={href}
                aria-current={
                  path === href ||
                  (href === '/tasks' && path.startsWith('/tasks/'))
                    ? 'page'
                    : undefined
                }
              >
                {label}
              </a>
            ))}
          </div>
          <div className="nav-actions">
            <ThemeToggle />
            {api && (
              <button
                className="button button-secondary button-small"
                onClick={() => {
                  setApi(null);
                  setStorageNotice(undefined);
                }}
              >
                断开连接
              </button>
            )}
          </div>
        </nav>
      </header>
      <main id="main" className="page-container" tabIndex={-1}>
        {storageNotice && <p role="status">{storageNotice}</p>}
        {page}
      </main>
      <footer className="site-footer page-container">
        <span>ProofRun</span>
        <span>浏览器验证执行平台</span>
      </footer>
    </>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
