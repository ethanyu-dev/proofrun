import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiClient } from './api';
import { Empty, ThemeToggle } from './components/ui';
import { Connect } from './components/connect';
import { TaskListPage } from './pages/task-list';
import { ReportDetailPage } from './pages/report-detail';
import { TaskDetailPage } from './pages/task-detail';
import { TaskSubmitPage } from './pages/task-submit';
import { NodesPage } from './pages/nodes';
import { IdentitiesPage } from './pages/identities';
import { HitlPage } from './pages/hitl';
import { suspendCredentialRestore } from './credential-storage';
import './tokens.css';
import './style.css';

/** 路由只接受协议允许的任务身份，未知路径显示明确的缺失页面。 */
const TASK_ROUTE = /^\/tasks\/([A-Za-z0-9_-]{1,128})$/;
/** 报告路由绑定单次任务身份，与任务详情保持独立导航。 */
const REPORT_ROUTE = /^\/reports\/([A-Za-z0-9_-]{1,128})$/;
const NAVIGATION = [
  ['/tasks', '验证任务'],
  ['/nodes', '执行节点'],
  ['/identities', '测试身份'],
  ['/reports', '验证报告'],
];

/** 仅使用页内路由与页面级读取，不引入第二份任务状态或调度器。 */
function App() {
  const [api, setApi] = useState<ApiClient | null>(null);
  const [autoRestore, setAutoRestore] = useState(true);
  /** 本地保存失败不阻断已验证的连接，但明确提示本次不能记住凭据。 */
  const [storageNotice, setStorageNotice] = useState<string>();
  /** 保持回调身份稳定，避免路由变化重复发起自动验证。 */
  const connected = useCallback((client: ApiClient, saved: boolean) => {
    setStorageNotice(
      saved
        ? undefined
        : '已连接，但浏览器未允许保存凭据；再次打开时需要重新输入。',
    );
    setApi(client);
  }, []);
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
  const reportId = REPORT_ROUTE.exec(path)?.[1];
  let page;
  if (!api) page = <Connect onConnect={connected} autoRestore={autoRestore} />;
  else if (path === '/tasks' || path === '/reports')
    page = <TaskListPage key={path} api={api} reports={path === '/reports'} />;
  else if (path === '/tasks/new') page = <TaskSubmitPage api={api} />;
  else if (reportId)
    page = <ReportDetailPage key={reportId} api={api} id={reportId} />;
  else if (taskId) page = <TaskDetailPage key={taskId} api={api} id={taskId} />;
  else if (path === '/nodes') page = <NodesPage api={api} />;
  else if (path === '/identities') page = <IdentitiesPage api={api} />;
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
                  ((href === '/tasks' || href === '/reports') &&
                    path.startsWith(`${href}/`))
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
                  const saved = suspendCredentialRestore();
                  setAutoRestore(false);
                  setApi(null);
                  setStorageNotice(
                    saved
                      ? undefined
                      : '已断开，但浏览器无法保存断开状态；请在站点设置中清除本地数据。',
                  );
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
