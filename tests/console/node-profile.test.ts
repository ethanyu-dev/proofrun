import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { ApiClient } from '../../apps/console/src/api.ts';
import { HitlPage } from '../../apps/console/src/pages/hitl.tsx';
import { NodeProfileStart } from '../../apps/console/src/components/node-profile-start.tsx';

/** 使用真实 React 组件进行静态检查，连接行为由独立 WS 夹具核实。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// 范围：同一操作组件按入口区分保存关闭与交还 Agent；不验证真实浏览器布局和保存结果。
test('节点模板共用 HITL 交互但显示独立保存关闭语义', () => {
  const api = new ApiClient('fixture-console-token');
  const html = renderToStaticMarkup(
    createElement(HitlPage, { id: 'fixture', api }),
  );
  assert.match(html, />保存并关闭</);
  assert.match(html, />不保存并关闭</);
  assert.doesNotMatch(html, />无法处理</);
  assert.match(html, /前往远端网址/);
  assert.match(html, /已有身份基准不受影响/);
  const start = renderToStaticMarkup(
    createElement(NodeProfileStart, {
      api,
      nodeId: 'node',
      name: '本地节点',
      close: () => {},
    }),
  );
  assert.match(start, /首次打开的网址/);
  assert.match(start, /已有身份基准保持原版本/);
});

// 范围：凭据只在同源 WS 首帧发送，不进入地址；不代替服务端权限与跨站请求测试。
test('节点模板连接仅在首帧携带 Console 凭据', () => {
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const oldWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const sent: string[] = [];
  let opened: (() => void) | undefined;
  let connectedUrl = '';
  class SocketFixture {
    constructor(url: URL) {
      connectedUrl = url.href;
    }
    addEventListener(event: string, callback: () => void) {
      assert.equal(event, 'open');
      opened = callback;
    }
    send(value: string) {
      sent.push(value);
    }
  }
  try {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: {
        href: 'https://console.example.test/#/nodes',
        protocol: 'https:',
      },
    });
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: SocketFixture,
    });
    new ApiClient('console-fixture-secret').nodeProfile('session');
    assert.equal(
      connectedUrl,
      'wss://console.example.test/v1/node-profiles/connect',
    );
    assert.deepEqual(sent, []);
    opened!();
    assert.deepEqual(JSON.parse(sent[0]!), {
      type: 'authenticate',
      id: 'session',
      token: 'console-fixture-secret',
    });
  } finally {
    for (const [key, descriptor] of [
      ['location', oldLocation],
      ['WebSocket', oldWebSocket],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

// 范围：失败展示区别租约过期、正常关闭和已保存；静态渲染不验证远端浏览器或轮询时序。
test('维护结果显示具体失败码且不暗示旧模板丢失', async () => {
  const { NodeProfileOutcome } =
    await import('../../apps/console/src/components/node-profile-outcome.tsx');
  const status = {
    ready: false,
    closed: true,
    closing: true,
    saveStatus: null,
    failure: {
      code: 'SESSION_LEASE_EXPIRED',
      errorCode: 'DEADLINE_EXCEEDED',
      closeReason: 'SESSION_LEASE_EXPIRED',
      message: '节点未能在租约到期前完成续租，浏览器已停止。',
    },
  };
  const html = renderToStaticMarkup(
    createElement(NodeProfileOutcome, { status, closing: false }),
  );
  assert.match(html, /维护会话失败/);
  assert.match(html, /SESSION_LEASE_EXPIRED/);
  assert.match(html, /DEADLINE_EXCEEDED/);
  assert.match(html, /之前已保存的模板不会因此被删除/);
  assert.match(html, /重新创建维护会话/);
  const normal = renderToStaticMarkup(
    createElement(NodeProfileOutcome, {
      status: { ...status, failure: null },
      closing: false,
    }),
  );
  assert.doesNotMatch(normal, /维护会话失败|错误码/);
  const saved = renderToStaticMarkup(
    createElement(NodeProfileOutcome, {
      status: { ...status, saveStatus: 'saved' },
      closing: false,
    }),
  );
  assert.match(saved, /本次节点默认 profile 已保存/);
  assert.doesNotMatch(saved, /本次没有确认发布/);
});
