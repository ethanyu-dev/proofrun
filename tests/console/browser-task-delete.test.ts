import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Window } from 'happy-dom';

/** 使用控制台 React 与 DOM 夹具，不连接真实浏览器或服务端。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);

// 范围：列表和详情删除、状态保护、取消、重复点击、失败重试及分页刷新；不证明数据库删除或真实布局。
test('浏览器任务列表和详情复用确认删除，成功刷新或返回列表', async (context) => {
  const window = new Window({
    url: 'http://localhost/#/browser-tasks',
  });
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
  const { BrowserTaskListPage } =
    await import('../../apps/console/src/pages/browser-task-list.tsx');
  const { TaskDetailPage } =
    await import('../../apps/console/src/pages/task-detail.tsx');
  const { ApiClient, ApiError } = await import('../../apps/console/src/api');
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container);
  const api = new ApiClient('fixture');
  const tasks = [
    'QUEUED',
    'RUNNING',
    'COMPLETED',
    'CANCELLED',
    'TIMED_OUT',
    'ERROR',
  ].map((state) => ({
    id: state,
    objective: `目标 ${state}`,
    state,
    target_url: 'https://example.test',
    created_at: '2026-10-28T00:00:00Z',
  }));
  const posts: { path: string; body: unknown }[] = [];
  const reads: string[] = [];
  let rejectFirst: (error: Error) => void = () => {};
  context.mock.method(
    api,
    'json',
    async (path: string, _signal: AbortSignal, body?: unknown) => {
      if (body !== undefined) {
        posts.push({ path, body });
        if (posts.length === 1)
          await new Promise((_resolve, reject) => {
            rejectFirst = reject;
          });
        const id = path.split('/')[3]!;
        const index = tasks.findIndex((task) => task.id === id);
        if (index >= 0) tasks.splice(index, 1);
        return { deletedTaskIds: [id], deletedRequestIds: [] };
      }
      reads.push(path);
      if (path.startsWith('/v1/tasks?')) {
        const query = new URL(path, 'http://localhost').searchParams;
        return {
          tasks: structuredClone(tasks),
          nextCursor: query.has('cursor') ? null : 'page-2',
        };
      }
      return {
        id: 'detail-fixture',
        state: 'CANCELLED',
        executions: [],
        report: null,
        definition: {
          taskKind: 'browser',
          objective: '详情目标',
          target: { url: 'https://example.test' },
        },
      };
    },
  );
  const button = (label: string, scope: ParentNode = window.document) => {
    const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === label,
    );
    assert.ok(found, `缺少按钮：${label}`);
    return found;
  };
  const card = (state: string) => {
    const found = [...container.querySelectorAll('article')].find((item) =>
      item.textContent?.includes(`目标 ${state}`),
    );
    assert.ok(found, `缺少卡片：${state}`);
    return found;
  };
  try {
    await act(async () => root.render(h(BrowserTaskListPage, { api })));
    for (const state of ['QUEUED', 'RUNNING']) {
      assert.equal(button('删除记录', card(state)).disabled, true);
      await act(async () => button('删除记录', card(state)).click());
      assert.equal(window.document.querySelector('[role="dialog"]'), null);
    }
    for (const state of ['COMPLETED', 'CANCELLED', 'TIMED_OUT', 'ERROR'])
      assert.equal(button('删除记录', card(state)).disabled, false);
    await act(async () => button('删除记录', card('COMPLETED')).click());
    assert.equal(posts.length, 0);
    assert.match(
      window.document.querySelector('[role="dialog"]')!.textContent!,
      /目标 COMPLETED/,
    );
    await act(async () => button('取消').click());
    assert.equal(posts.length, 0);
    assert.equal(window.document.querySelector('[role="dialog"]'), null);
    await act(async () => button('删除记录', card('COMPLETED')).click());
    await act(async () => {
      button('确认删除').click();
      button('确认删除').click();
    });
    assert.deepEqual(posts, [{ path: '/v1/tasks/COMPLETED/delete', body: {} }]);
    assert.equal(button('正在删除…').disabled, true);
    assert.equal(button('取消').disabled, true);
    await act(async () =>
      rejectFirst(
        new ApiError(
          409,
          'TASK_RESOURCES_OPEN',
          '任务会话或清理尚未结束，请稍后删除',
        ),
      ),
    );
    assert.match(
      window.document.querySelector('[role="dialog"]')!.textContent!,
      /任务会话或清理尚未结束/,
    );
    assert.equal(window.location.hash, '#/browser-tasks');
    assert.ok(card('COMPLETED'));
    await act(async () => button('确认删除').click());
    assert.deepEqual(posts[1], posts[0]);
    assert.equal(window.document.querySelector('[role="dialog"]'), null);
    assert.equal(container.querySelectorAll('article').length, 5);
    assert.doesNotMatch(container.textContent!, /目标 COMPLETED/);

    // 非首屏删除后重置游标，避免最后一项被删后停留在空页；列表请求由夹具响应。
    await act(async () => button('下一页').click());
    assert.match(reads.at(-1)!, /cursor=page-2/);
    await act(async () => button('删除记录', card('ERROR')).click());
    await act(async () => button('确认删除').click());
    assert.doesNotMatch(reads.at(-1)!, /cursor=/);
    assert.equal(button('上一页').disabled, true);
    assert.equal(container.querySelectorAll('article').length, 4);

    window.location.hash = '#/browser-tasks/detail-fixture';
    await act(async () =>
      root.render(h(TaskDetailPage, { api, id: 'detail-fixture' })),
    );
    await act(async () => button('删除记录').click());
    await act(async () => button('确认删除').click());
    assert.deepEqual(posts.at(-1), {
      path: '/v1/tasks/detail-fixture/delete',
      body: {},
    });
    assert.equal(window.location.hash, '#/browser-tasks');
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
