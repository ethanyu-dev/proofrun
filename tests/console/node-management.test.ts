import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Window } from 'happy-dom';

/** DOM 使用实际 React 与 Radix，接口均为夹具，不覆盖真实节点和网站登录。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);

// 范围：统一管理入口、域名表单版本和忙碌关闭保护、维护恢复与创建；不证明视觉布局或生产 API 可用。
test('节点管理操作集中展示，弹窗保留保存与维护协议', async (context) => {
  const window = new Window({ url: 'http://localhost' });
  const values: Record<string, unknown> = {
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
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
  values.getComputedStyle = window.getComputedStyle.bind(window);
  values.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  values.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
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
  const { NodesPage } = await import('../../apps/console/src/pages/nodes.tsx');
  const { ApiClient } = await import('../../apps/console/src/api.ts');
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container);
  const api = new ApiClient('fixture');
  const node = {
    id: 'node-fixture',
    name: '测试节点',
    pool: 'internal',
    online: true,
    occupied: 0,
    capabilities: { nodeDefaultProfileVersion: 1 },
    revoked_at: null,
    routing_domains: ['example.com'],
    routing_revision: 4,
  };
  const writes: { path: string; body: unknown }[] = [];
  let finishSave: () => void = () => {};
  context.mock.method(
    api,
    'json',
    async (path: string, _signal: AbortSignal, body?: unknown) => {
      if (body !== undefined) {
        writes.push({ path, body });
        if (path.endsWith('/routing'))
          await new Promise<void>((resolve) => {
            finishSave = resolve;
          });
        if (path.endsWith('/profile')) throw new Error('维护浏览器暂不可用');
        return {};
      }
      if (path.endsWith('/profile')) return { id: null };
      assert.equal(path, '/v1/nodes');
      return { nodes: [node] };
    },
  );
  const button = (name: string, parent = window.document.body) => {
    const found = [...parent.querySelectorAll('button')].find(
      (item) => item.textContent === name,
    );
    assert.ok(found, `缺少按钮：${name}`);
    return found;
  };
  try {
    await act(async () => root.render(h(NodesPage, { api })));
    const actions = container.querySelector(
      '[aria-label="测试节点 管理操作"]',
    )!;
    assert.deepEqual(
      [...actions.querySelectorAll('button')].map((item) => item.textContent),
      ['配置域名', '维护登录状态', '轮换凭据', '撤销节点'],
    );
    assert.equal(
      container.querySelector('[aria-label="节点默认登录状态"] button'),
      null,
    );
    assert.equal(
      container.querySelector('[aria-label="域名分发"] button'),
      null,
    );
    const trigger = button('配置域名');
    trigger.focus();
    await act(async () => trigger.click());
    let dialog = window.document.querySelector('[role="dialog"]')!;
    assert.ok(dialog);
    assert.equal(dialog.querySelector('textarea')!.value, 'example.com');
    await act(async () => button('清空列表').click());
    assert.equal(dialog.querySelector('textarea')!.value, '');
    await act(async () =>
      dialog
        .querySelector('form')!
        .dispatchEvent(
          new window.Event('submit', { bubbles: true, cancelable: true }),
        ),
    );
    assert.deepEqual(writes[0], {
      path: '/v1/nodes/node-fixture/routing',
      body: { domains: [], revision: 4 },
    });
    assert.equal(button('取消').disabled, true);
    await act(async () =>
      window.document.activeElement!.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      ),
    );
    assert.ok(window.document.querySelector('[role="dialog"]'));
    await act(async () => finishSave());
    assert.equal(window.document.querySelector('[role="dialog"]'), null);
    assert.equal(window.document.activeElement, trigger);

    await act(async () => button('维护登录状态').click());
    dialog = window.document.querySelector('[role="dialog"]')!;
    assert.ok(dialog.textContent!.includes('维护登录状态'));
    assert.equal(dialog.querySelector('input')!.getAttribute('type'), 'url');
    assert.ok(dialog.querySelector('input')!.labels?.length);
    await act(async () =>
      dialog
        .querySelector('form')!
        .dispatchEvent(
          new window.Event('submit', { bubbles: true, cancelable: true }),
        ),
    );
    assert.match(dialog.textContent!, /维护浏览器暂不可用/);
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.equal(button('取消').disabled, false);
    await act(async () => button('取消').click());
    assert.equal(window.document.querySelector('[role="dialog"]'), null);

    await act(async () => button('轮换凭据').click());
    assert.match(
      window.document.querySelector('[role="dialog"]')!.textContent!,
      /轮换节点凭据/,
    );
    await act(async () => button('取消').click());
    await act(async () => button('撤销节点').click());
    assert.equal(
      button('确认撤销').getAttribute('data-variant'),
      'destructive',
    );
    await act(async () => button('取消').click());
    assert.equal(writes.length, 2);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
