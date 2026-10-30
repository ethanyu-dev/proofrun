import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import test from 'node:test';
import { Window } from 'happy-dom';
import { ApiClient } from '../../apps/console/src/api.ts';

/** 使用 Console 的 React；CSS 只影响视觉，DOM 协议回归不解析样式。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
// 范围：真实组件的页签切换、线上按钮、请求身份及归档展示；HTTP 是夹具，不验收真实模型或生产部署。
test('生产模式 V2 页签可以发起线上测试，重试保持身份且不串基础运行', async (context) => {
  const hooks = registerHooks({
    load(url, context, next) {
      return url.endsWith('.css')
        ? { format: 'module', source: 'export {};', shortCircuit: true }
        : next(url, context);
    },
  });
  const window = new Window({ url: 'http://localhost/#/benchmarks' });
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    location: window.location,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of [
    'HTMLElement',
    'HTMLInputElement',
    'HTMLButtonElement',
    'HTMLFormElement',
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
    globals[key] = window[key as keyof Window];
  globals.getComputedStyle = window.getComputedStyle.bind(window);
  globals.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  globals.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
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
  const { createElement: h, act } = require('react');
  const { createRoot } = require('react-dom/client');
  const { BenchmarksPage } =
    await import('../../apps/console/src/pages/benchmarks.tsx');
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container);
  const api = new ApiClient('fixture');
  const release = {
    version: 'fixture-version',
    buildId: 'fixture',
    kind: 'release',
    commit: 'a'.repeat(40),
    sourceFingerprint: 'b'.repeat(64),
  };
  const reads: string[] = [];
  const posts: any[] = [];
  let activeFamily: string | null = null;
  const run = {
    schemaVersion: 2,
    suite: 'agent-loop-v2-deployed-v1',
    id: 'pending',
    createdAt: '2026-10-30T00:00:00Z',
    completedAt: null,
    release,
    origin: 'deployed',
    mode: 'deployed',
    source: { revision: release.commit, dirty: false },
    environment: { node: 'fixture', platform: 'fixture', arch: 'fixture' },
    config: { model: 'fixture', maxTurns: 436, maxContextChars: 64000 },
    cases: [
      {
        id: 'jiekou-referral',
        name: '接口历史任务夹具',
        scope: '仅 UI 夹具',
        elapsedMs: 0,
        verdict: 'QUEUED',
        checks: [{ name: '等待完成', passed: false, detail: '夹具' }],
        calls: [],
        commands: [],
        deployment: { api: null, agent: null, node: null, executionId: null },
        verification: {
          sourceTaskId: 'original',
          sourceCreatedAt: '2026-10-01T00:00:00Z',
          sourceDefinitionSha256: 'c'.repeat(64),
          historicalVerdict: 'PASSED',
          task: {},
          steps: [],
          report: null,
          sessionClosed: false,
        },
      },
    ],
  };
  context.mock.method(
    api,
    'json',
    async (path: string, _signal: AbortSignal, body?: any) => {
      if (body) {
        posts.push(structuredClone(body));
        if (posts.length === 1) throw new Error('夹具：创建回执超时');
        run.id = body.id;
        activeFamily = 'v2';
        return { id: body.id };
      }
      reads.push(path);
      if (path.endsWith('/status'))
        return {
          enabled: true,
          release,
          environment: 'fixture',
          nodePool: 'fixture',
          activeFamily,
        };
      if (path.includes('/versions?'))
        return { versions: [{ version: release.version }] };
      if (path.includes('/benchmarks?'))
        return {
          runs:
            activeFamily && path.includes('family=v2')
              ? [
                  {
                    id: run.id,
                    release,
                    createdAt: run.createdAt,
                    state: 'RUNNING',
                  },
                ]
              : [],
          nextCursor: null,
        };
      return { state: 'RUNNING', run: structuredClone(run) };
    },
  );
  const button = (text: string) => {
    const found = [...window.document.querySelectorAll('button')].find(
      (b) => b.textContent === text,
    );
    assert(found, `缺少按钮 ${text}`);
    return found;
  };
  const switchTab = (text: string) =>
    act(async () => {
      button(text).dispatchEvent(
        new window.MouseEvent('mousedown', { bubbles: true, button: 0 }),
      );
    });
  try {
    await act(async () => root.render(h(BenchmarksPage, { api })));
    assert(button('发起线上基准'));
    await switchTab('V2 真实任务');
    assert.equal(button('开始 V2 测试').disabled, false);
    assert(reads.some((path) => path.includes('/benchmarks?family=v2')));
    assert(reads.some((path) => path.endsWith('/versions?family=v2')));
    await act(async () => button('开始 V2 测试').click());
    assert.match(container.textContent!, /创建回执超时/);
    await act(async () => button('开始 V2 测试').click());
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[0], posts[1]);
    assert.equal(posts[1].family, 'v2');
    assert.equal(Object.keys(posts[1]).sort().join(), 'family,id');
    assert.match(container.textContent!, /接口历史任务夹具/);
    await switchTab('浏览器任务');
    assert.doesNotMatch(container.textContent!, /接口历史任务夹具/);
    assert.match(container.textContent!, /正在运行另一个测试集：V2 真实任务/);
    assert.equal(button('运行中…').disabled, true);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    hooks.deregister();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
