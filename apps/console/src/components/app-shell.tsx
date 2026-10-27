import type { ReactNode } from 'react';
import { Button } from './ui/button';
import { ThemeToggle } from './ui';

/** 导航仅映射已有路由，详情与历史入口归属对应业务模块。 */
const NAVIGATION = [
  { href: '/dashboard', label: '验证看板', prefixes: ['/dashboard'] },
  {
    href: '/tasks',
    label: '验证任务',
    prefixes: ['/tasks', '/requests', '/reports', '/request-reports'],
  },
  { href: '/browser-tasks', label: '浏览器任务', prefixes: ['/browser-tasks'] },
  { href: '/nodes', label: '执行节点', prefixes: ['/nodes', '/node-profiles'] },
];

/** 控制台外壳只处理布局与导航；连接验证和业务数据仍由原页面管理。 */
export function AppShell({
  path,
  connected,
  disconnect,
  children,
}: {
  /** 当前页内路径，用于导航高亮。 */
  path: string;
  /** 只表示管理员连接已验证，不代表节点在线。 */
  connected: boolean;
  /** 由入口统一清理连接状态及自动恢复偏好。 */
  disconnect: () => void;
  children: ReactNode;
}) {
  const route = path.split('?')[0]!;
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
        <div className="site-nav">
          <a className="brand" href="#/tasks">
            ProofRun<span className="brand-label">控制台</span>
          </a>
          <nav className="nav-links" aria-label="主导航">
            {NAVIGATION.map(({ href, label, prefixes }) => (
              <a
                href={`#${href}`}
                key={href}
                aria-current={
                  prefixes.some(
                    (prefix) =>
                      route === prefix || route.startsWith(`${prefix}/`),
                  )
                    ? 'page'
                    : undefined
                }
              >
                {label}
              </a>
            ))}
          </nav>
          <div className="nav-actions">
            <ThemeToggle />
            {connected && (
              <Button variant="outline" onClick={disconnect}>
                断开连接
              </Button>
            )}
          </div>
        </div>
      </header>
      <main id="main" className="page-container" tabIndex={-1}>
        {children}
      </main>
    </>
  );
}
