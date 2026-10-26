import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Window } from 'happy-dom';
import { ApiClient } from '../../apps/console/src/api.ts';
import { RequestDetailPage } from '../../apps/console/src/pages/request-detail.tsx';

/** 真实 React 组件配合内存 DOM；HTTP 与报告使用夹具，不证明真实浏览器验收。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement, act } = require('react');

// 范围：报告汇总、Case 结果及轮询期间不调用已退役分析入口；不覆盖视觉排版与真实服务。
test('报告直接展示汇总与 Case，不生成或轮询分析', async (context) => {
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
  const requests: { path: string; body?: unknown }[] = [];
  const api = new ApiClient('fixture');
  context.mock.method(
    api,
    'json',
    async (path: string, _signal: AbortSignal, body?: unknown) => {
      requests.push({ path, body });
      assert.equal(path, '/v2/requests/fixture/report');
      return {
        requestId: 'fixture',
        title: '报告夹具',
        executionStatus: 'FINISHED',
        createdAt: '2026-10-19T00:00:00Z',
        reportPhase: 'FINAL',
        caseCount: 0,
        cases: [],
        metrics: {
          executionElapsedMs: 273000,
          totalTokens: 577300,
          execution: {
            promptTokens: 554787,
            completionTokens: 22513,
            totalTokens: 577300,
            calls: 20,
          },
          jev: {
            promptTokens: 100000,
            completionTokens: 5000,
            totalTokens: 105000,
            calls: 12,
          },
          llm: {
            promptTokens: 454787,
            completionTokens: 17513,
            totalTokens: 472300,
            calls: 8,
          },
        },
      };
    },
  );
  try {
    await act(async () =>
      root.render(
        createElement(RequestDetailPage, { api, id: 'fixture', reports: true }),
      ),
    );
    const text = container.textContent!;
    assert.ok(text.indexOf('测试报告总体汇总') >= 0);
    assert.ok(text.indexOf('测试报告总体汇总') < text.indexOf('case 验证结果'));
    assert.match(text, /未能判定/);
    assert.match(text, /4 分 33 秒/);
    assert.match(text, /验证 Tokens 合计577,300/);
    assert.match(text, /JEV（历史）105,000/);
    assert.match(text, /LLM472,300/);
    assert.doesNotMatch(
      text,
      /Agent 分析|生成分析|重新分析|本次 Tokens|累计 Tokens/,
    );
    await act(async () => context.mock.timers.tick(5000));
    assert.ok(requests.length > 0);
    assert.ok(
      requests.every(
        ({ path, body }) =>
          path === '/v2/requests/fixture/report' && body === undefined,
      ),
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
