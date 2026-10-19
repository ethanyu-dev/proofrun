import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Window } from 'happy-dom';
import { ApiClient } from '../../apps/console/src/api.ts';
import { RequestDetailPage } from '../../apps/console/src/pages/request-detail.tsx';

/** 真实 React 组件配合内存 DOM；HTTP 与分析文本使用夹具，不证明真实模型结论。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement, act } = require('react');

// 范围：页面顺序、自动生成去重、轮询和重跑旧结果展示；不覆盖视觉排版与真实服务。
test('报告按汇总、分析、case 展示，生成与重跑不阻塞结果', async (context) => {
  const window = new Window({
    url: 'http://localhost/#/request-reports/fixture',
  });
  const globals = {
    window,
    document: window.document,
    location: window.location,
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
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let analysis: any = null;
  const posts: any[] = [];
  const api = new ApiClient('fixture');
  context.mock.method(
    api,
    'json',
    async (path: string, _signal: AbortSignal, body?: unknown) => {
      if (!path.endsWith('/analysis'))
        return {
          requestId: 'fixture',
          title: '报告夹具',
          executionStatus: 'FINISHED',
          createdAt: '2026-10-19T00:00:00Z',
          reportPhase: 'FINAL',
          caseCount: 0,
          cases: [],
        };
      if (body) {
        posts.push(body);
        analysis = { ...analysis, status: 'QUEUED' };
      }
      return analysis;
    },
  );
  try {
    await act(async () =>
      root.render(
        createElement(RequestDetailPage, { api, id: 'fixture', reports: true }),
      ),
    );
    const text = container.textContent!;
    assert.ok(text.indexOf('测试报告总体汇总') < text.indexOf('Agent 分析'));
    assert.ok(text.indexOf('Agent 分析') < text.indexOf('case 验证结果'));
    assert.match(text, /未能判定/);
    assert.deepEqual(posts, [{ rerun: false }]);
    await act(async () => context.mock.timers.tick(5000));
    assert.equal(posts.length, 1);
    analysis = {
      status: 'SUCCEEDED',
      summary: '已生成的简洁结论',
      generatedAt: '2026-10-19T01:00:00Z',
      model: 'fixture',
    };
    await act(async () => context.mock.timers.tick(5000));
    assert.match(container.textContent!, /已生成的简洁结论/);
    const button = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '重新分析',
    )!;
    await act(async () => button.click());
    assert.deepEqual(posts[1], { rerun: true });
    assert.match(container.textContent!, /上一版分析/);
    assert.match(container.textContent!, /已生成的简洁结论/);
    assert.equal(button.disabled, true);
    analysis = {
      ...analysis,
      status: 'FAILED',
      error: '分析生成失败，请重新分析。',
    };
    await act(async () => context.mock.timers.tick(5000));
    assert.equal(button.disabled, false);
    assert.match(container.textContent!, /分析生成失败/);
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
