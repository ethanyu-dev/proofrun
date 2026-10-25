import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Window } from 'happy-dom';

/** 使用控制台同一份 React，避免测试运行器加载另一份组件运行时。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement, act } = require('react');

// 范围：真实组件点击、请求体、失败重试与刷新导航；HTTP 使用内存夹具，不证明服务端事务或浏览器视觉布局。
test('整体和单 case 重跑留在原请求页，未知结果重试复用身份', async (context) => {
  const window = new Window({ url: 'http://localhost/#/requests/fixture' });
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
  const { RequestDetailPage } =
    await import('../../apps/console/src/pages/request-detail.tsx');
  const { ApiClient, ApiError } = await import('../../apps/console/src/api');
  const { createRoot } = require('react-dom/client');
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container);
  const api = new ApiClient('fixture');
  const value = {
    requestId: 'fixture',
    title: '重跑夹具',
    createdAt: '2026-10-25T00:00:00Z',
    caseCount: 2,
    cases: ['alpha', 'beta'].map((caseId) => ({
      caseId,
      title: caseId,
      executionOrigin: 'created',
      steps: [],
      criteria: [],
      arms: [
        {
          taskId: `old-${caseId}`,
          executionMode: 'llm',
          result: { status: 'COMPLETED' },
        },
      ],
    })),
  };
  const posts: { path: string; body: any }[] = [];
  let rejectFirst: (error: Error) => void = () => {};
  let reads = 0;
  let rejectNext = false;
  context.mock.method(
    api,
    'json',
    async (path: string, _signal: AbortSignal, body?: any) => {
      if (!body) {
        reads++;
        return structuredClone(value);
      }
      posts.push({ path, body: structuredClone(body) });
      if (rejectNext) {
        rejectNext = false;
        throw new ApiError(422, 'LOCAL_IDENTITY_REMOVED', '需要重新选择身份');
      }
      if (posts.length === 1)
        await new Promise((_resolve, reject) => {
          rejectFirst = reject;
        });
      for (const mapping of body.caseIds) {
        const member = value.cases.find(
          (c) => c.caseId === mapping.sourceCaseId,
        )!;
        member.arms = [
          {
            taskId: `case-run-${mapping.runId}`,
            executionMode: 'llm',
            result: { status: 'QUEUED' },
          },
        ];
      }
      return structuredClone(value);
    },
  );
  const button = (label: string) => {
    const found = Array.from(window.document.querySelectorAll('button')).find(
      (b) => b.textContent === label,
    );
    assert.ok(found, `缺少按钮：${label}`);
    return found;
  };
  const choose = async (index: number, label: string) => {
    const trigger =
      window.document.querySelectorAll('[role="combobox"]')[index]!;
    await act(async () => {
      trigger.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'ArrowDown',
          bubbles: true,
        }),
      );
    });
    const option = [
      ...window.document.querySelectorAll('[role="option"]'),
    ].find((item) => item.textContent === label)!;
    assert.ok(option);
    await act(async () => {
      (option as unknown as HTMLElement).focus();
      option.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
  };
  const submit = async () => {
    await act(async () => button('提交重跑').click());
  };
  try {
    await act(async () =>
      root.render(createElement(RequestDetailPage, { api, id: 'fixture' })),
    );
    const whole = button('重跑整个请求');
    await act(async () => {
      whole.click();
    });
    assert.equal(posts.length, 0);
    await choose(0, '访客（未登录）');
    await choose(1, '当前会话人工登录');
    await act(async () => {
      button('提交重跑').click();
      button('提交重跑').click();
    });
    assert.equal(posts.length, 1);
    assert.deepEqual(
      posts[0].body.caseIds.map((c: any) => c.session),
      [{ mode: 'guest' }, { mode: 'manual' }],
    );
    assert.equal(whole.disabled, true);
    assert.equal(posts[0].path, '/v2/requests/fixture/rerun');
    assert.equal(posts[0].body.requestId, undefined);
    assert.deepEqual(
      posts[0].body.caseIds.map((c: any) => c.sourceCaseId),
      ['alpha', 'beta'],
    );
    await act(async () =>
      rejectFirst(new ApiError(408, 'HTTP_ERROR', '响应丢失夹具')),
    );
    assert.match(window.document.body.textContent!, /响应丢失夹具/);
    assert.ok(
      [...window.document.querySelectorAll('[role="combobox"]')].every(
        (field) => field.hasAttribute('disabled'),
      ),
    );
    await act(async () => button('重试提交').click());
    assert.deepEqual(posts[1], posts[0]);
    assert.equal(window.location.hash, '#/requests/fixture');
    assert.ok(reads >= 2);
    assert.ok(
      container.querySelector(`a[href*="${value.cases[0].arms[0].taskId}"]`),
    );
    const unchanged = value.cases[0].arms[0].taskId;
    const beta = container.querySelectorAll('.request-case')[1]!;
    const single = beta.querySelector('button')!;
    assert.equal(single.textContent, '重跑此 case');
    await act(async () => single.click());
    await submit();
    assert.equal(posts[2].body.caseIds.length, 1);
    assert.equal(posts[2].body.caseIds[0].sourceCaseId, 'beta');
    assert.equal(value.cases[0].arms[0].taskId, unchanged);
    assert.equal(window.location.hash, '#/requests/fixture');
    await act(async () => single.click());
    await submit();
    assert.notEqual(
      posts[3].body.caseIds[0].runId,
      posts[2].body.caseIds[0].runId,
    );
    await act(async () => button('重跑整个请求').click());
    await submit();
    assert.notDeepEqual(posts[4].body.caseIds, posts[0].body.caseIds);
    // 明确拒绝后允许重新配置并更换运行身份；仍然只覆盖模拟 HTTP。
    rejectNext = true;
    await act(async () => button('重跑整个请求').click());
    await submit();
    assert.ok(
      !window.document
        .querySelectorAll('[role="combobox"]')[0]!
        .hasAttribute('disabled'),
      window.document.body.textContent!,
    );
    await choose(0, '当前会话人工登录');
    await submit();
    assert.notEqual(
      posts[6].body.caseIds[0].runId,
      posts[5].body.caseIds[0].runId,
    );
    assert.deepEqual(posts[6].body.caseIds[0].session, { mode: 'manual' });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
