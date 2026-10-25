import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Window } from 'happy-dom';

/** 复用控制台的 React；DOM 和 HTTP 均为夹具，不代表真实浏览器布局或服务端删除。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);

// 范围：详情页按钮位置、执行状态保护、确认取消、重复点击、失败重试和成功导航；统计级联由数据库测试覆盖。
test('请求详情删除记录经确认提交，失败保留页面，成功返回任务列表', async (context) => {
  const window = new Window({
    url: 'http://localhost/#/requests/delete-fixture',
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
  const { RequestDelete } =
    await import('../../apps/console/src/components/request-delete.tsx');
  const { RequestDetailPage } =
    await import('../../apps/console/src/pages/request-detail.tsx');
  const { ApiClient, ApiError } = await import('../../apps/console/src/api');
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container);
  const value = {
    requestId: 'delete-fixture',
    title: '待删除请求',
    createdAt: '2026-10-25T00:00:00Z',
    sourceRequestId: 'source-fixture',
    executionStatus: 'FINISHED',
    caseCount: 2,
    cases: ['alpha', 'beta'].map((caseId) => ({
      caseId,
      title: caseId,
      executionOrigin: 'created',
      steps: [],
      criteria: [],
      arms: [
        {
          taskId: `task-${caseId}`,
          executionMode: 'llm',
          result: { status: 'ERROR' },
        },
      ],
    })),
  };
  const api = new ApiClient('fixture');
  const posts: { path: string; body: unknown }[] = [];
  let rejectFirst: (error: Error) => void = () => {};
  context.mock.method(
    api,
    'json',
    async (path: string, _signal: AbortSignal, body?: unknown) => {
      if (body === undefined) return structuredClone(value);
      posts.push({ path, body });
      if (posts.length === 1)
        await new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      return {
        deletedRequestIds: [value.requestId],
        deletedTaskIds: ['task-alpha', 'task-beta'],
      };
    },
  );
  const button = (label: string) => {
    const found = [...window.document.querySelectorAll('button')].find(
      (item) => item.textContent === label,
    );
    assert.ok(found, `缺少按钮：${label}`);
    return found;
  };
  try {
    for (const executionStatus of ['QUEUED', 'IN_PROGRESS']) {
      await act(async () =>
        root.render(
          h(RequestDelete, { api, value: { ...value, executionStatus } }),
        ),
      );
      assert.equal(button('删除记录').disabled, true);
      await act(async () => button('删除记录').click());
      assert.equal(window.document.querySelector('[role="dialog"]'), null);
    }
    await act(async () =>
      root.render(h(RequestDetailPage, { api, id: value.requestId })),
    );
    const metadata = container.querySelector('.request-detail-meta')!;
    assert.match(metadata.textContent!, /查看重跑来源删除记录/);
    assert.ok(metadata.contains(button('删除记录')));
    await act(async () => button('删除记录').click());
    assert.equal(posts.length, 0);
    assert.match(
      window.document.querySelector('[role="dialog"]')!.textContent!,
      /2 个 case/,
    );
    await act(async () => button('取消').click());
    assert.equal(posts.length, 0);
    assert.equal(window.document.querySelector('[role="dialog"]'), null);
    await act(async () => button('删除记录').click());
    await act(async () => {
      button('确认删除').click();
      button('确认删除').click();
    });
    assert.deepEqual(posts, [
      { path: '/v2/requests/delete-fixture/delete', body: {} },
    ]);
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
    assert.equal(window.location.hash, '#/requests/delete-fixture');
    assert.match(
      window.document.querySelector('[role="dialog"]')!.textContent!,
      /任务会话或清理尚未结束/,
    );
    await act(async () => button('确认删除').click());
    assert.deepEqual(posts[1], posts[0]);
    assert.equal(window.location.hash, '#/tasks');
    assert.equal(window.document.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
