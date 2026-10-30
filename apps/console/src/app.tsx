import { lazy, useCallback, useEffect, useState } from 'react';
import { ApiClient } from './api';
import { Empty } from './components/ui';
import { AppShell } from './components/app-shell';
import { Connect } from './components/connect';
import { suspendCredentialRestore } from './credential-storage';

/** 按路由加载页面，避免连接页下载报告解析、图表和所有管理表单。 */
const RequestListPage = lazy(() =>
  import('./pages/request-list').then((module) => ({
    default: module.RequestListPage,
  })),
);
const BrowserTaskListPage = lazy(() =>
  import('./pages/browser-task-list').then((module) => ({
    default: module.BrowserTaskListPage,
  })),
);
const DashboardPage = lazy(() =>
  import('./pages/dashboard').then((module) => ({
    default: module.DashboardPage,
  })),
);
/** 基准页与其他 Console 管理页面共用连接鉴权，验证成功后才加载。 */
const BenchmarksPage = lazy(() =>
  import('./pages/benchmarks').then((module) => ({
    default: module.BenchmarksPage,
  })),
);
const RequestDetailPage = lazy(() =>
  import('./pages/request-detail').then((module) => ({
    default: module.RequestDetailPage,
  })),
);
const ReportDetailPage = lazy(() =>
  import('./pages/report-detail').then((module) => ({
    default: module.ReportDetailPage,
  })),
);
const TaskDetailPage = lazy(() =>
  import('./pages/task-detail').then((module) => ({
    default: module.TaskDetailPage,
  })),
);
const TaskSubmitPage = lazy(() =>
  import('./pages/task-submit').then((module) => ({
    default: module.TaskSubmitPage,
  })),
);
const NodesPage = lazy(() =>
  import('./pages/nodes').then((module) => ({ default: module.NodesPage })),
);
const NodeProfilePage = lazy(() =>
  import('./pages/node-profile').then((module) => ({
    default: module.NodeProfilePage,
  })),
);
const HitlPage = lazy(() =>
  import('./pages/hitl').then((module) => ({ default: module.HitlPage })),
);

/** 路由只接受协议允许的任务身份，已移除的索引路径不作为任务 ID 读取。 */
const TASK_ROUTE =
  /^\/tasks\/((?!(?:executions|ungrouped)$)[A-Za-z0-9_-]{1,128})$/;
/** 报告详情保留单次任务入口，同样排除已移除的索引路径。 */
const REPORT_ROUTE =
  /^\/reports\/((?!(?:executions|ungrouped)$)[A-Za-z0-9_-]{1,128})$/;
/** 仅使用页内路由与页面级读取，不引入第二份任务状态或调度器。 */
export function App() {
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
  const nodeProfileId = /^\/node-profiles\/([A-Za-z0-9_-]{1,128})$/.exec(
    path,
  )?.[1];
  const taskId = TASK_ROUTE.exec(path.split('?')[0]!)?.[1];
  const browserTaskId = /^\/browser-tasks\/([A-Za-z0-9_-]{1,128})$/.exec(
    path.split('?')[0]!,
  )?.[1];
  const reportId = REPORT_ROUTE.exec(path.split('?')[0]!)?.[1];
  const requestRoute =
    /^\/(requests|request-reports)\/([A-Za-z0-9_-]{1,80})$/.exec(path);
  let page;
  // 所有管理页共用同一凭据验证入口；本地基准和归档导入也不能绕过连接。
  if (!api) page = <Connect onConnect={connected} autoRestore={autoRestore} />;
  else if (path === '/benchmarks') page = <BenchmarksPage api={api} />;
  else if (path === '/dashboard') page = <DashboardPage api={api} />;
  else if (['/tasks', '/reports'].includes(path.split('?')[0]!))
    // 旧报告列表地址继续可访问，统一展示任务列表和逐请求报告入口。
    page = (
      <RequestListPage key={path} api={api} query={path.split('?')[1] ?? ''} />
    );
  else if (requestRoute)
    page = (
      <RequestDetailPage
        key={path}
        api={api}
        id={requestRoute[2]!}
        reports={requestRoute[1] === 'request-reports'}
      />
    );
  else if (path === '/browser-tasks') page = <BrowserTaskListPage api={api} />;
  else if (path === '/browser-tasks/new')
    page = <TaskSubmitPage api={api} initialKind="browser" />;
  else if (path === '/tasks/new') page = <TaskSubmitPage api={api} />;
  else if (browserTaskId)
    // 实时入口重新选择当前执行，避免沿用上次查看的历史操作。
    page = <TaskDetailPage key={path} api={api} id={browserTaskId} />;
  else if (reportId)
    page = <ReportDetailPage key={reportId} api={api} id={reportId} />;
  else if (taskId) page = <TaskDetailPage key={taskId} api={api} id={taskId} />;
  else if (nodeProfileId)
    page = <NodeProfilePage key={nodeProfileId} api={api} id={nodeProfileId} />;
  else if (path === '/nodes') page = <NodesPage api={api} />;
  else
    page = (
      <Empty title="页面不存在">
        <a href="#/tasks">返回任务列表</a>
      </Empty>
    );
  return (
    <AppShell
      path={path}
      connected={!!api}
      disconnect={() => {
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
      {storageNotice && (
        <p className="report-notice" role="status">
          {storageNotice}
        </p>
      )}
      {page}
    </AppShell>
  );
}
