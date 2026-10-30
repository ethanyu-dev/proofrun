import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { Empty } from './components/ui';
import { Toaster } from './components/ui/sonner';
import './components/ui/theme.css';
import './tokens.css';
import './style.css';
import './requests.css';
import './dashboard.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
createRoot(root).render(
  <StrictMode>
    <Suspense
      fallback={
        <div className="page-container" role="status">
          <Empty title="正在加载页面…" />
        </div>
      }
    >
      <App />
    </Suspense>
    <Toaster
      position="bottom-right"
      closeButton
      toastOptions={{ duration: 4000, closeButtonAriaLabel: '关闭通知' }}
    />
  </StrictMode>,
);
