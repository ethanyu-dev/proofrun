import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Window } from 'happy-dom';
import {
  dashboardRange,
  dashboardToday,
  type DashboardPeriod,
  type DashboardStatistics,
} from '@proofrun/contracts/dashboard';
import { ApiClient } from '../../apps/console/src/api.ts';
import { DashboardPage } from '../../apps/console/src/pages/dashboard.tsx';
import { RequestListPage } from '../../apps/console/src/pages/request-list.tsx';
import { dashboardTokens } from '../../apps/console/src/components/dashboard-charts.tsx';

/** 使用控制台自己的 React，HTTP 数据由本测试注入。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement, act } = require('react');

/** 夹具保留零分母与缺失用量，用于验证展示不伪造零值。 */
function response(path: string): DashboardStatistics {
  const params = new URL(path, 'http://localhost').searchParams;
  const period = params.get('period') as DashboardPeriod;
  const range = dashboardRange(period, params.get('date')!);
  const usage = {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    calls: 1,
    unmeasuredCalls: 1,
  };
  const empty = {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    calls: 0,
    unmeasuredCalls: 0,
  };
  const metrics = {
    runs: 1,
    cases: {
      total: 1,
      passed: 0,
      failed: 0,
      inconclusive: 0,
      pending: 1,
      finished: 0,
      passRate: null,
    },
    tokens: usage,
    execution: usage,
    legacyUsageTasks: 0,
  };
  return {
    period,
    timeZone: 'Asia/Shanghai',
    startDate: range.startDate,
    endDate: range.endDate,
    generatedAt: new Date().toISOString(),
    summary: metrics,
    days: range.days.map((date) => ({ date, ...metrics })),
  };
}

// 范围：真实 React 周期切换、错误保留和过期响应隔离；不覆盖实际数据库、视觉布局或模型计费。
test('看板按周期读取，错误与未上报用量明确展示', async (context) => {
  const window = new Window({ url: 'http://localhost/#/dashboard' });
  const globals = {
    window,
    document: window.document,
    location: window.location,
    HTMLFormElement: window.HTMLFormElement,
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
  const api = new ApiClient('fixture');
  const paths: string[] = [];
  let fail = false;
  let defer = false;
  let delayed: (() => void) | undefined;
  context.mock.method(api, 'json', async (path: string) => {
    paths.push(path);
    if (path.startsWith('/v2/requests'))
      return { requests: [], nextCursor: null };
    if (fail) throw new Error('统计连接失败');
    if (defer) {
      defer = false;
      return new Promise((resolve) => {
        delayed = () =>
          resolve({
            ...response(path),
            summary: {
              ...response(path).summary,
              cases: { ...response(path).summary.cases, total: 987654 },
            },
          });
      });
    }
    return response(path);
  });
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find(
      (item) => item.textContent === label,
    )!;
  try {
    await act(async () => root.render(createElement(DashboardPage, { api })));
    assert.match(paths[0]!, /period=week/);
    assert.match(container.textContent!, /暂无已结束 Case/);
    assert.match(container.textContent!, /Case 整体通过率/);
    assert.match(container.textContent!, /请求内 Case 数/);
    const rangeLink = () =>
      [...container.querySelectorAll('a')].find(
        (link) => link.textContent === '查看本周期验证任务',
      )!;
    const week = dashboardRange('week', dashboardToday());
    assert.equal(
      rangeLink().getAttribute('href'),
      `#/tasks?startDate=${week.startDate}&endDate=${week.endDate}`,
    );
    assert.match(container.textContent!, /未上报/);
    assert.match(container.textContent!, /1 次用量不完整/);
    assert.equal(
      (container.querySelector('[aria-label="下一周期"]') as HTMLButtonElement)
        .disabled,
      true,
    );
    await act(async () => button('月').click());
    assert.match(paths.at(-1)!, /period=month/);
    const month = dashboardRange('month', dashboardToday());
    assert.equal(
      rangeLink().getAttribute('href'),
      `#/tasks?startDate=${month.startDate}&endDate=${month.endDate}`,
    );
    assert.equal(
      container.querySelectorAll('.dashboard-daily tbody tr').length,
      dashboardRange('month', dashboardToday()).days.length,
    );
    await act(async () =>
      (
        container.querySelector('[aria-label="上一周期"]') as HTMLButtonElement
      ).click(),
    );
    const historyRequests = paths.length;
    await act(async () => context.mock.timers.tick(5000));
    assert.equal(paths.length, historyRequests);
    await act(async () => button('本月').click());
    fail = true;
    await act(async () => button('刷新').click());
    assert.match(
      container.querySelector('[role="alert"]')!.textContent!,
      /统计连接失败/,
    );
    assert.equal(container.querySelectorAll('.dashboard-kpi').length, 4);
    fail = false;
    defer = true;
    await act(async () => button('日').click());
    assert.equal(container.querySelectorAll('.dashboard-kpi').length, 0);
    await act(async () => button('周').click());
    await act(async () => delayed!());
    assert.doesNotMatch(container.textContent!, /987,654/);
    assert.equal(button('周').getAttribute('aria-pressed'), 'true');
    await act(async () =>
      (
        container.querySelector(
          '.dashboard-daily tbody button',
        ) as HTMLButtonElement
      ).click(),
    );
    assert.match(paths.at(-1)!, /period=day/);
    assert.equal(
      container.querySelectorAll('.dashboard-daily tbody tr').length,
      1,
    );
    // 范围：看板日期条件传入任务页并在搜索后保留；HTTP 返回为空夹具，不验证数据库。
    await act(async () =>
      root.render(
        createElement(RequestListPage, {
          api,
          query: 'startDate=2024-03-04&endDate=2024-03-10',
        }),
      ),
    );
    assert.match(paths.at(-1)!, /startDate=2024-03-04&endDate=2024-03-10/);
    assert.match(
      container.textContent!,
      /请求创建日期：2024-03-04 — 2024-03-10（北京时间）/,
    );
    await act(async () =>
      container
        .querySelector('form')!
        .dispatchEvent(
          new window.Event('submit', { bubbles: true, cancelable: true }),
        ),
    );
    assert.match(paths.at(-1)!, /startDate=2024-03-04&endDate=2024-03-10/);
    assert.equal(
      container.querySelector('a[href="#/tasks"]')?.textContent,
      '查看全部任务',
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

// 范围：纯展示函数区分无调用、真实零用量及未知用量；不推断供应商账单。
test('Token 格式不会将未知用量写成零', () => {
  const empty = {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    calls: 0,
    unmeasuredCalls: 0,
  };
  assert.equal(dashboardTokens(empty), '0');
  assert.equal(
    dashboardTokens({ ...empty, calls: 1, unmeasuredCalls: 1 }),
    '未上报',
  );
  assert.equal(dashboardTokens({ ...empty, calls: 1, totalTokens: 0 }), '0');
});
