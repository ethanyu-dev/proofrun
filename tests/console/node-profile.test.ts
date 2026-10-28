import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Window } from 'happy-dom';
import { ApiClient } from '../../apps/console/src/api.ts';
import { NodeDefaultProfile } from '../../apps/console/src/components/node-default-profile.tsx';
import { NodeProfilePage } from '../../apps/console/src/pages/node-profile.tsx';

/** 使用实际组件与 DOM，API 为状态夹具；不代表真实节点或浏览器维护验收。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement, act } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// 范围：节点能力控制入口，已保存版本与未知状态区分；不证明网站登录有效。
test('节点卡片只对支持模板的在线节点开放维护入口', () => {
  const node = {
    id: 'node',
    name: '测试节点',
    online: true,
    capabilities: {},
    revoked_at: null,
  };
  const api = new ApiClient('fixture');
  const old = renderToStaticMarkup(
    createElement(NodeDefaultProfile, { api, node }),
  );
  assert.match(old, /disabled=""/);
  assert.match(old, /节点未上报模板状态/);
  const active = renderToStaticMarkup(
    createElement(NodeDefaultProfile, {
      api,
      node: {
        ...node,
        capabilities: { nodeDefaultProfileVersion: 1 },
        default_profile: {
          version: 'fixture-version',
          updatedAt: '2026-10-28T00:00:00Z',
        },
      },
    }),
  );
  assert.match(active, /维护登录状态/);
  assert.match(active, /fixture-version/);
  assert.doesNotMatch(active, /disabled=""/);
});

// 范围：真实组件先恢复已有会话，再读取维护/保存/关闭状态；HTTP 与发布结果为夹具。
test('维护入口恢复已有会话，保存未确认时不展示成功', async (context) => {
  const window = new Window({ url: 'http://localhost/#/nodes' });
  const globals = {
    window,
    document: window.document,
    location: window.location,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
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
  const api = new ApiClient('fixture');
  let status: any = {
    id: 'existing',
    nodeId: 'node',
    taskId: 'maintenance',
    managed: true,
    publishState: 'SAVING',
    ready: false,
    closed: false,
    closing: false,
    path: '/#/hitl/existing/token',
  };
  const calls: string[] = [];
  context.mock.method(
    api,
    'json',
    async (path: string, _signal: AbortSignal, body?: unknown) => {
      calls.push(path);
      assert.equal(body, undefined);
      return path.endsWith('/profile')
        ? { id: 'existing' }
        : structuredClone(status);
    },
  );
  try {
    await act(async () =>
      root.render(
        createElement(NodeDefaultProfile, {
          api,
          node: {
            id: 'node',
            online: true,
            capabilities: { nodeDefaultProfileVersion: 1 },
          },
        }),
      ),
    );
    await act(async () => container.querySelector('button')!.click());
    assert.equal(window.location.hash, '#/node-profiles/existing');
    assert.deepEqual(calls, ['/v1/nodes/node/profile']);
    await act(async () =>
      root.render(createElement(NodeProfilePage, { api, id: 'existing' })),
    );
    assert.match(container.textContent!, /正在保存/);
    assert.doesNotMatch(container.textContent!, /默认登录状态已保存/);
    assert.equal(container.querySelector('a[target="_blank"]'), null);
    status = {
      ...status,
      publishState: 'SAVED',
      closed: true,
      closing: true,
      profile: {
        version: 'confirmed-version',
        updatedAt: '2026-10-28T00:00:00Z',
      },
    };
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('刷新'))!
        .click(),
    );
    assert.match(container.textContent!, /默认登录状态已保存/);
    assert.match(container.textContent!, /confirmed-version/);
    assert.match(container.textContent!, /已关闭/);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
