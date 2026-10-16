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
