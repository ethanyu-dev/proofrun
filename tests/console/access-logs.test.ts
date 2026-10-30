import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test, { type TestContext } from 'node:test';
import { Window } from 'happy-dom';

/** 使用真实 React/Radix 和隔离 DOM；网络请求由各用例明确替换。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);

/** 浏览器全局只在当前用例有效，不接触真实站点存储或凭据。 */
function browser(t: TestContext) {
  const window = new Window({ url: 'http://localhost' });
  const values: Record<string, unknown> = {
    window,
    document: window.document,
    localStorage: window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  };
  for (const key of [
    'HTMLFormElement',
    'HTMLButtonElement',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLSelectElement',
    'Element',
    'Node',
    'NodeFilter',
    'DocumentFragment',
    'MutationObserver',
    'ResizeObserver',
    'CustomEvent',
    'Event',
    'KeyboardEvent',
  ])
    values[key] = window[key as keyof Window];
  const previous = new Map(
    Object.keys(values).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createElement: h, act } = require('react');
  const { createRoot } = require('react-dom/client');
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { window, container, root, h, act };
}

// 范围：页面记录、错误、分页和筛选重置；使用夹具响应，不证明生产数据、视觉布局或代理来源真实性。
test('访问记录显示登录结果并按类型筛选，切换时清除旧游标', async (t) => {
  const { window, container, root, h, act } = browser(t);
  const { AccessLogsPage } =
    await import('../../apps/console/src/pages/access-logs.tsx');
  const { ApiClient } = await import('../../apps/console/src/api.ts');
  const api = new ApiClient('fixture');
  const paths: string[] = [];
  let fail = false;
  t.mock.method(api, 'json', async (path: string) => {
    paths.push(path);
    if (fail) throw new Error('读取访问记录失败');
    const params = new URL(path, 'http://localhost').searchParams;
    return {
      retentionDays: 30,
      nextCursor: params.has('before') ? null : '50',
      records: [
        {
          id: '51',
          at: '2026-10-30T00:00:00Z',
          ip: '2001:db8::1',
          kind: 'console_login',
          method: 'POST',
          route: '/v1/admin/console-login',
          statusCode: 401,
          durationMs: 2.5,
        },
      ],
    };
  });
  const button = (label: string) => {
    const found = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === label,
    );
    assert.ok(found, label);
    return found;
  };
  await act(async () => root.render(h(AccessLogsPage, { api })));
  assert.match(container.textContent!, /2001:db8::1/);
  assert.match(container.textContent!, /401 · 凭据无效/);
  assert.match(container.textContent!, /最近 30 天/);
  await act(async () => button('下一页').click());
  assert.match(paths.at(-1)!, /before=50/);
  assert.equal(button('下一页').disabled, true);
  const trigger = container.querySelector('[role="combobox"]')!;
  await act(async () =>
    trigger.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    ),
  );
  const option = [...window.document.querySelectorAll('[role="option"]')].find(
    (item) => item.textContent === '控制台登录',
  )!;
  await act(async () =>
    option.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    ),
  );
  assert.match(paths.at(-1)!, /kind=console_login/);
  assert.doesNotMatch(paths.at(-1)!, /before=/);
  assert.equal(button('上一页').disabled, true);
  fail = true;
  await act(async () => button('刷新').click());
  assert.match(
    container.querySelector('[role="alert"]')!.textContent!,
    /读取访问记录失败/,
  );
  assert.match(container.textContent!, /2001:db8::1/);
  fail = false;
  await act(async () => button('重置').click());
  assert.doesNotMatch(paths.at(-1)!, /kind=|before=/);
});

// 范围：手动连接、自动恢复和鉴权拒绝的实际客户端调用；fetch 为夹具，不代表真实服务器鉴权。
test('手动登录与自动恢复均通过独立 POST 验证，失败不交接客户端', async (t) => {
  const { window, container, root, h, act } = browser(t);
  const { Connect } =
    await import('../../apps/console/src/components/connect.tsx');
  const requests: {
    path: string;
    method: string | undefined;
    body: unknown;
  }[] = [];
  let accepted = 0;
  let denied = false;
  t.mock.method(
    globalThis,
    'fetch',
    async (path: string, init: RequestInit) => {
      requests.push({ path, method: init.method, body: init.body });
      return new Response(
        JSON.stringify(denied ? { code: 'UNAUTHORIZED' } : { connected: true }),
        {
          status: denied ? 401 : 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  );
  window.localStorage.setItem(
    'proofrun.console.credential',
    'fixture-saved-token',
  );
  const connected = () => {
    accepted++;
  };
  await act(async () =>
    root.render(
      h(Connect, { key: 'manual', autoRestore: false, onConnect: connected }),
    ),
  );
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(
        new window.Event('submit', { bubbles: true, cancelable: true }),
      ),
  );
  assert.equal(accepted, 1);
  await act(async () =>
    root.render(
      h(Connect, { key: 'restore', autoRestore: true, onConnect: connected }),
    ),
  );
  assert.equal(accepted, 2);
  denied = true;
  await act(async () =>
    root.render(
      h(Connect, { key: 'denied', autoRestore: true, onConnect: connected }),
    ),
  );
  assert.equal(accepted, 2);
  assert.match(container.textContent!, /凭据无效/);
  assert.equal(requests.length, 3);
  assert.ok(
    requests.every(
      (r) =>
        r.path === '/v1/admin/console-login' &&
        r.method === 'POST' &&
        r.body === '{}',
    ),
  );
});
