import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Window } from 'happy-dom';
import type { RequestResultV2 } from '@proofrun/contracts';
import { ApiClient } from '../../apps/console/src/api.ts';
import { RequestDetailPage } from '../../apps/console/src/pages/request-detail.tsx';
import { RequestReportContent } from '../../apps/console/src/components/request-report-content.tsx';

/** 真实 React 组件配合内存 DOM；HTTP 与分析文本使用夹具，不证明真实模型结论。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement, act } = require('react');

// 范围：用量分区、重跑旧结果展示和全成功时停止分析请求；不覆盖视觉排版与真实服务。
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
  let analysisRequests = 0;
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
          metrics: {
            executionElapsedMs: 273000,
            totalTokens: 610300,
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
            analysis: {
              promptTokens: 30000,
              completionTokens: 3000,
              totalTokens: 33000,
              calls: 5,
            },
          },
        };
      analysisRequests++;
      if (body) {
        posts.push(body);
        analysis = {
          ...analysis,
          status: 'QUEUED',
          ...(analysis?.usage
            ? {
                usage: {
                  current: {
                    promptTokens: null,
                    completionTokens: null,
                    totalTokens: null,
                    calls: 0,
                  },
                  cumulative: analysis.usage.cumulative,
                },
              }
            : {}),
        };
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
    assert.match(text, /4 分 33 秒/);
    assert.match(text, /验证 Tokens 合计577,300/);
    assert.doesNotMatch(text, /610,300/);
    assert.match(text, /JEV（历史）105,000/);
    assert.match(text, /LLM472,300/);
    assert.match(text, /累计 Tokens33,000/);
    assert.doesNotMatch(text, /部分用量未知/);
    assert.deepEqual(posts, [{ rerun: false }]);
    await act(async () => context.mock.timers.tick(5000));
    assert.equal(posts.length, 1);
    analysis = {
      status: 'SUCCEEDED',
      summary: '已生成的简洁结论',
      generatedAt: '2026-10-19T01:00:00Z',
      model: 'fixture',
      usage: {
        current: {
          promptTokens: 30000,
          completionTokens: 3000,
          totalTokens: 33000,
          calls: 5,
        },
        cumulative: {
          promptTokens: 31000,
          completionTokens: 3100,
          totalTokens: 34100,
          calls: 6,
        },
      },
    };
    await act(async () => context.mock.timers.tick(5000));
    assert.match(container.textContent!, /已生成的简洁结论/);
    const overview = container.querySelector(
      '[aria-label="测试报告总体汇总"]',
    )!;
    const analysisPanel = container.querySelector('[aria-label="Agent 分析"]')!;
    const currentUsage = () =>
      [...analysisPanel.querySelectorAll('tr')].find((row) =>
        row.textContent!.startsWith('Agent 分析（本次）'),
      )!.textContent!;
    assert.match(currentUsage(), /Agent 分析（本次）30,0003,00033,0005/);
    assert.doesNotMatch(overview.textContent!, /Agent|33,000|34,100/);
    assert.match(analysisPanel.textContent!, /累计 Tokens34,100/);
    const details = analysisPanel.querySelector('details')!;
    assert.equal(details.open, false);
    await act(async () => details.querySelector('summary')!.click());
    assert.equal(details.open, true);
    assert.equal(overview.querySelector('details')!.open, false);
    const button = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === '重新分析',
    )!;
    await act(async () => button.click());
    assert.deepEqual(posts[1], { rerun: true });
    assert.match(container.textContent!, /上一版分析/);
    assert.match(container.textContent!, /已生成的简洁结论/);
    assert.equal(button.disabled, true);
    assert.match(currentUsage(), /Agent 分析（本次）———0/);
    assert.match(analysisPanel.textContent!, /累计 Tokens34,100/);
    assert.equal(details.open, true);
    analysis = {
      ...analysis,
      status: 'FAILED',
      error: '分析生成失败，请重新分析。',
    };
    await act(async () => context.mock.timers.tick(5000));
    assert.equal(button.disabled, false);
    assert.match(container.textContent!, /分析生成失败/);
    // 已有分析内容或历史消耗不能让全成功报告继续展示分析卡片。
    const successful = {
      requestId: 'success',
      cases: [
        {
          criteria: [{ criterionId: 'c' }],
          arms: [
            {
              executionMode: 'jev',
              result: {
                status: 'COMPLETED',
                reportStatus: 'PASSED',
                result: { criteria: [{ criterionId: 'c', verdict: 'PASSED' }] },
              },
            },
          ],
        },
      ],
    } as unknown as RequestResultV2;
    const requestsBeforeSuccess = analysisRequests;
    await act(async () =>
      root.render(
        createElement(RequestReportContent, { api, value: successful }),
      ),
    );
    assert.ok(container.querySelector('[aria-label="测试报告总体汇总"]'));
    assert.equal(container.querySelector('[aria-label="Agent 分析"]'), null);
    assert.doesNotMatch(
      container.textContent!,
      /重新分析|本次 Tokens|累计 Tokens/,
    );
    await act(async () => context.mock.timers.tick(5000));
    assert.equal(analysisRequests, requestsBeforeSuccess);
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
