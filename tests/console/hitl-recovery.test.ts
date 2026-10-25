import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Window } from 'happy-dom';
import { HitlPage } from '../../apps/console/src/pages/hitl.tsx';

/** 使用真实 React 状态与 DOM 事件，WebSocket 为可控制夹具，不声称验证真实画面传输。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement, act } = require('react');

// 范围：无首帧导航、超时提示、重连不重放及权限边界；不覆盖 Chrome 坐标输入和公网网络。
test('人工页面没有首帧时仍可导航，超时可重连且不重放操作', async (context) => {
  const window = new Window({ url: 'http://localhost/#/hitl/fixture/token' });
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror = null;
    sent: any[] = [];
    constructor() {
      sockets.push(this);
    }
    send(raw: string) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    receive(value: unknown) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
  }
  const globals = {
    window,
    document: window.document,
    location: window.location,
    localStorage: window.localStorage,
    WebSocket: Socket,
    fetch: async () => ({
      ok: true,
      json: async () => ({
        state: state('HUMAN'),
        direct: {
          controlUrl: 'wss://node.test/hitl/control',
          frameUrl: 'wss://node.test/hitl/frames',
          id: 'fixture',
          token: 'direct-fixture',
        },
      }),
    }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const prior = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createRoot } = require('react-dom/client');
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container);
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const button = (text: string) =>
    [...container.querySelectorAll('button')].find(
      (b) => b.textContent === text,
    )!;
  const state = (mode: string) => ({
    type: 'state',
    taskId: 'fixture',
    mode,
    reason: '测试准备',
    items: [],
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    canSaveAuth: false,
    targetUrl: 'https://example.com/login',
  });
  try {
    await act(async () =>
      root.render(
        createElement(HitlPage, { id: 'fixture', token: 'fixture-only' }),
      ),
    );
    await act(async () => {
      sockets[0]!.onopen?.();
      sockets[0]!.receive(state('REQUESTED'));
    });
    assert.equal(button('前往').disabled, true);
    await act(async () => sockets[0]!.receive(state('HUMAN')));
    assert.equal(container.querySelector('img.hitl-screen'), null);
    assert.equal(button('前往').disabled, false);
    await act(async () =>
      container
        .querySelector('form.hitl-navigation')!
        .dispatchEvent(
          new window.Event('submit', { bubbles: true, cancelable: true }),
        ),
    );
    const sent = sockets[0]!.sent.filter((m) => m.type === 'command');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].command, {
      type: 'browser.act',
      action: 'navigate',
      target: 'https://example.com/login',
    });
    assert.equal(button('重新连接').disabled, true);
    await act(async () =>
      sockets[0]!.receive({
        type: 'result',
        commandId: sent[0].commandId,
        status: 'SUCCEEDED',
        effect: 'COMPLETED',
      }),
    );
    await act(async () => context.mock.timers.tick(10001));
    assert.match(container.textContent!, /浏览器画面加载超时/);
    assert.equal(button('重新连接').disabled, false);
    await act(async () => button('重新连接').click());
    assert.equal(sockets.length, 3);
    await act(async () => {
      sockets[2]!.onopen?.();
      sockets[2]!.receive(state('HUMAN'));
    });
    assert.equal(
      sockets[2]!.sent.filter((m) => m.type === 'command').length,
      0,
    );
    assert.doesNotMatch(container.textContent!, /浏览器画面加载超时/);
    await act(async () =>
      sockets[2]!.receive({
        type: 'frame',
        data: 'fixture',
        width: 1280,
        height: 720,
      }),
    );
    await act(async () => context.mock.timers.tick(10001));
    assert.ok(container.querySelector('img.hitl-screen'));
    assert.doesNotMatch(container.textContent!, /浏览器画面加载超时/);
    await act(async () => sockets[2]!.close());
    assert.equal(button('前往').disabled, true);
  } finally {
    await act(async () => root.unmount());
    context.mock.timers.reset();
    await window.happyDOM.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
