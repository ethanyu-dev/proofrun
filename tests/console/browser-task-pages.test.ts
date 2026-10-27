import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Window } from 'happy-dom';
import { ApiClient } from '../../apps/console/src/api.ts';

/** DOM 夹具验证页面交互，不连接真实浏览器或服务端。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);

// 范围：列表筛选分页、详情人工处理和旧报告分流；不证明真实视频流或 Agent 目标完成。
test('浏览器任务列表与详情按显式类型隔离历史验证', async (context) => {
  const window = new Window({ url: 'http://localhost' });
  const values: Record<string, unknown> = {
    window,
    document: window.document,
    location: window.location,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of [
    'HTMLFormElement',
    'HTMLButtonElement',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLSelectElement',
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
    values[key] = window[key as keyof Window];
  values.getComputedStyle = window.getComputedStyle.bind(window);
  values.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  values.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  const previous = new Map(
    Object.keys(values).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createElement: h, act } = require('react');
  const { createRoot } = require('react-dom/client');
  const { BrowserTaskListPage } =
    await import('../../apps/console/src/pages/browser-task-list.tsx');
  const { TaskDetailPage } =
    await import('../../apps/console/src/pages/task-detail.tsx');
  const { ReportDetailPage } =
    await import('../../apps/console/src/pages/report-detail.tsx');
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container);
  const api = new ApiClient('fixture');
  const reads: string[] = [];
  const task = {
    id: 'browser-fixture',
    state: 'RUNNING',
    definition: {
      taskKind: 'browser',
      objective: '整理价格',
      target: { url: 'https://example.test' },
      acceptanceCriteria: [],
    },
    executions: [
      {
        id: 'execution-fixture',
        state: 'RUNNING',
        control_mode: 'HUMAN',
        control_revision: 1,
        control_reason: '请完成登录',
        action_count: 1,
      },
    ],
    report: null as any,
  };
  context.mock.method(api, 'json', async (path: string) => {
    reads.push(path);
    if (path.startsWith('/v1/tasks?')) {
      const query = new URL(path, 'http://localhost').searchParams;
      assert.equal(query.get('taskKind'), 'browser');
      return {
        tasks: ['RUNNING', 'COMPLETED', 'QUEUED']
          .filter(
            (state) => !query.has('state') || query.get('state') === state,
          )
          .map((state) => ({
            id: state,
            state,
            objective: `目标 ${state}`,
            target_url: 'https://example.test',
            created_at: '2026-10-27T00:00:00Z',
          })),
        nextCursor: query.has('cursor') ? null : 'page-2',
      };
    }
    if (path.endsWith('/timeline')) return { commands: [], nextCursor: null };
    if (path.endsWith('/intervention'))
      return { intervention: { path: '#/hitl/fixture/token' } };
    if (path.endsWith('/requests')) return { requests: [] };
    if (path === '/v1/tasks/browser-fixture') return structuredClone(task);
    throw new Error(`Unexpected fixture request: ${path}`);
  });
  const click = async (label: string) => {
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === label,
    )!;
    assert.ok(button, label);
    await act(async () => button.click());
  };
  const select = async (label: string) => {
    const trigger = container.querySelector('[role="combobox"]')!;
    await act(async () =>
      trigger.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
        }),
      ),
    );
    const option = [
      ...window.document.querySelectorAll('[role="option"]'),
    ].find((item) => item.textContent === label)!;
    assert.ok(option, label);
    await act(async () =>
      option.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      ),
    );
  };
  try {
    await act(async () => root.render(h(BrowserTaskListPage, { api })));
    assert.equal(container.querySelectorAll('.request-list-card').length, 3);
    assert.equal(container.querySelectorAll('a[href$="?view=live"]').length, 1);
    assert.equal(
      container.querySelector('a[href$="?view=live"]')!.getAttribute('href'),
      '#/browser-tasks/RUNNING?view=live',
    );
    assert.doesNotMatch(container.textContent!, /验证报告|通过率/);
    await click('下一页');
    assert.match(reads.at(-1)!, /cursor=page-2/);
    await select('执行中');
    assert.match(reads.at(-1)!, /state=RUNNING/);
    assert.doesNotMatch(reads.at(-1)!, /cursor=/);
    assert.equal(container.querySelectorAll('.request-list-card').length, 1);
    await select('全部');
    assert.doesNotMatch(reads.at(-1)!, /state=|cursor=/);

    await act(async () => root.render(h(TaskDetailPage, { api, id: task.id })));
    assert.ok(container.querySelector('[aria-label="待处理事项"]'));
    assert.ok(container.querySelector('a[href="#/hitl/fixture/token"]'));
    assert.ok(container.querySelector('[aria-label="实时交互"]'));
    assert.ok(
      container.innerHTML.indexOf('execution-workspace') <
        container.innerHTML.indexOf('浏览器任务结果'),
    );
    await act(async () =>
      container.querySelector('button.execution-step')!.click(),
    );
    assert.ok(container.querySelector('[aria-label="操作回放"]'));
    assert.ok(container.querySelector('a[href="#/hitl/fixture/token"]'));
    assert.doesNotMatch(
      container.textContent!,
      /验证报告|验收通过|其他操作|此步骤/,
    );

    // 自动执行订阅只读画面，选择记录释放订阅；模拟连接不代表真实视频传输验收。
    const streams: Array<{ closed: boolean; close(): void }> = [];
    context.mock.method(api, 'live', async (executionId: string) => {
      assert.equal(executionId, 'execution-fixture');
      const stream = {
        closed: false,
        close() {
          this.closed = true;
        },
      };
      streams.push(stream);
      return stream as unknown as WebSocket;
    });
    task.executions[0]!.control_mode = 'AUTO';
    await act(async () =>
      root.render(h(TaskDetailPage, { key: 'automatic', api, id: task.id })),
    );
    assert.equal(streams.length, 1);
    assert.equal(container.querySelector('[aria-label="待处理事项"]'), null);
    await act(async () =>
      container.querySelector('button.execution-step')!.click(),
    );
    assert.equal(streams[0]!.closed, true);
    await click('实时画面');
    assert.equal(streams.length, 2);

    task.state = 'COMPLETED';
    task.executions[0]!.state = 'CLOSED';
    task.report = {
      summary: '已整理价格',
      browserResult: {
        outcome: 'COMPLETED',
        output: '最终结果正文',
        evidenceRefs: [],
      },
      artifacts: [],
    };
    await act(async () =>
      root.render(h(TaskDetailPage, { key: 'completed', api, id: task.id })),
    );
    assert.match(container.textContent!, /最终结果正文/);
    assert.ok(
      container.innerHTML.indexOf('浏览器任务结果') <
        container.innerHTML.indexOf('execution-workspace'),
    );
    assert.equal(container.querySelector('[aria-label="待处理事项"]'), null);
    assert.equal(container.querySelector('[aria-label="实时交互"]'), null);
    assert.doesNotMatch(container.textContent!, /报告|通过率/);

    reads.length = 0;
    window.location.hash = '#/reports/browser-fixture';
    await act(async () =>
      root.render(h(ReportDetailPage, { api, id: task.id })),
    );
    assert.equal(window.location.hash, '#/browser-tasks/browser-fixture');
    assert.doesNotMatch(container.textContent!, /验证报告/);
    assert.equal(
      reads.some((path) => path.endsWith('/requests')),
      false,
    );

    // 缺少类型标记的任务即使没有验收项，也必须保留历史报告入口。
    delete (task.definition as { taskKind?: string }).taskKind;
    task.report = null;
    window.location.hash = '#/reports/browser-fixture';
    await act(async () =>
      root.render(h(ReportDetailPage, { key: 'history', api, id: task.id })),
    );
    assert.equal(window.location.hash, '#/reports/browser-fixture');
    assert.match(container.textContent!, /验证报告/);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
