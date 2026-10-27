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
          nodeId: 'bound-node',
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
    // 范围：前端携带 API 返回的绑定身份，不能只凭介入 ID 路由；不验证真实节点认证。
    assert.equal(sockets[0]!.sent[0].nodeId, 'bound-node');
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
      sockets[3]!.receive({
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
    // 范围：保留旧帧但禁止坐标和文字输入，新一轮媒体首帧到达后才恢复；不验证真实 JPEG 解码。
    assert.ok(container.querySelector('img.hitl-screen'));
    assert.equal(
      container.querySelector('img.hitl-screen')!.getAttribute('aria-disabled'),
      'true',
    );
    assert.match(container.textContent!, /上次画面/);
    assert.equal(button('Enter').disabled, true);
    await act(async () => context.mock.timers.tick(1000));
    await act(async () => {
      sockets[4]!.onopen?.();
      sockets[4]!.receive(state('HUMAN'));
    });
    assert.equal(button('Enter').disabled, true);
    await act(async () =>
      sockets[5]!.receive({
        type: 'frame',
        data: 'fresh',
        width: 1280,
        height: 720,
      }),
    );
    assert.equal(button('Enter').disabled, false);
    assert.doesNotMatch(container.textContent!, /上次画面/);
    assert.equal(
      sockets[4]!.sent.filter((m) => m.type === 'command').length,
      0,
    );
    // 范围：真实页面绑定按缩放坐标提交单条拖动，期间禁止交还，后续 click 不重复提交；WebSocket 仍为夹具。
    const screen = container.querySelector('img.hitl-screen')!;
    assert.equal(screen.getAttribute('draggable'), 'false');
    screen.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 640, height: 360 }) as DOMRect;
    await act(async () =>
      screen.dispatchEvent(
        new window.PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          isPrimary: true,
          button: 0,
          buttons: 1,
          clientX: 100,
          clientY: 100,
        }),
      ),
    );
    assert.equal(button('完成，继续任务').disabled, true);
    assert.equal(
      sockets[4]!.sent.filter((m) => m.type === 'command').length,
      0,
    );
    await act(async () => {
      window.dispatchEvent(
        new window.PointerEvent('pointermove', {
          pointerId: 1,
          buttons: 1,
          clientX: 200,
          clientY: 100,
        }),
      );
      window.dispatchEvent(
        new window.PointerEvent('pointerup', {
          pointerId: 1,
          button: 0,
          clientX: 200,
          clientY: 100,
        }),
      );
      screen.dispatchEvent(
        new window.MouseEvent('click', {
          bubbles: true,
          detail: 1,
          clientX: 200,
          clientY: 100,
        }),
      );
    });
    const drag = sockets[4]!.sent.filter((m) => m.type === 'command');
    assert.equal(drag.length, 1);
    assert.equal(drag[0].command.action, 'drag');
    assert.deepEqual(drag[0].command.points[0], { x: 200, y: 200, atMs: 0 });
    assert.equal(drag[0].command.points.at(-1).x, 400);
    await act(async () =>
      sockets[4]!.receive({
        type: 'result',
        commandId: drag[0].commandId,
        status: 'SUCCEEDED',
        effect: 'APPLIED',
      }),
    );
    assert.equal(button('完成，继续任务').disabled, false);
    // 范围：读取只读证据不会伪造待办确认，倒计时取实际等待期限而非四小时链接。
    await act(async () =>
      sockets[4]!.receive({
        ...state('HUMAN'),
        runtimeEvidenceAvailable: true,
        expiresAt: new Date(Date.now() + 4 * 3600000).toISOString(),
        waitDeadline: new Date(Date.now() + 60000).toISOString(),
      }),
    );
    assert.doesNotMatch(container.textContent!, /4 小时|240 分/);
    await act(async () => button('读取运行时证据').click());
    const probe = sockets[4]!.sent.filter((m) => m.type === 'command').at(-1);
    assert.deepEqual(probe.command, {
      type: 'browser.observe',
      screenshot: false,
    });
    await act(async () =>
      sockets[4]!.receive({
        type: 'result',
        commandId: probe.commandId,
        status: 'SUCCEEDED',
        effect: 'APPLIED',
        evidence: {
          runtime: { status: 'observed', serviceWorker: { registrations: [] } },
        },
      }),
    );
    assert.match(container.textContent!, /serviceWorker/);
    assert.equal(
      sockets[4]!.sent.filter((m) => m.type === 'complete').length,
      0,
    );
    // 范围：交接应答超时后忙碌标记释放，人工可以重新查询；不证明服务端是否已完成交接。
    await act(async () => button('完成，继续任务').click());
    await act(async () => context.mock.timers.tick(150000));
    assert.equal(button('重新连接').disabled, false);
    assert.match(container.textContent!, /交接结果未确认/);
    assert.equal(
      container.querySelector('img.hitl-screen')!.getAttribute('aria-disabled'),
      'true',
    );
    assert.equal(
      sockets[4]!.sent.filter((m) => m.type === 'complete').length,
      1,
    );
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
