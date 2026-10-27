import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
import { ApiClient } from '../../apps/console/src/api.ts';

/** DOM 夹具使用控制台 React，不访问真实 API 或真实浏览器。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);

// 范围：两个输入、切换保留、提交防重与失败重试；HTTP 为夹具，不证明服务端执行成功。
test('浏览器任务仅编辑网址和目标，切换与网络重试保留身份', async (context) => {
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
    'HTMLTextAreaElement',
    'Element',
    'Node',
    'NodeFilter',
    'DocumentFragment',
    'MutationObserver',
    'ResizeObserver',
    'CustomEvent',
    'Event',
    'KeyboardEvent',
    'MouseEvent',
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
  const { TaskSubmitPage } =
    await import('../../apps/console/src/pages/task-submit.tsx');
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container);
  const bodies: Array<{ taskId: string; url: string; objective: string }> = [];
  let reply: ((value: Response) => void) | undefined;
  context.mock.method(
    globalThis,
    'fetch',
    async (path: unknown, init: RequestInit) => {
      assert.equal(path, '/v1/browser-tasks');
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      assert.deepEqual(Object.keys(body).sort(), [
        'objective',
        'taskId',
        'url',
      ]);
      if (bodies.length === 1) throw new TypeError('fixture network failure');
      return new Promise<Response>((resolve) => {
        reply = resolve;
      });
    },
  );
  try {
    await act(async () =>
      root.render(
        h(TaskSubmitPage, {
          api: new ApiClient('fixture'),
          initialKind: 'browser',
        }),
      ),
    );
    const form = container.querySelector('form[aria-label="浏览器任务"]')!;
    assert.equal(form.querySelectorAll('input,textarea').length, 2);
    assert.doesNotMatch(
      container.textContent!,
      /v1 兼容入口|表单模式|JSON 模式|验收标准/,
    );
    // 调用原生 setter 后派发事件，使 React 按真实输入路径读取新值。
    for (const [id, value, prototype] of [
      [
        'browser-url',
        'https://example.test/',
        window.HTMLInputElement.prototype,
      ],
      [
        'browser-objective',
        '查询价格并整理表格',
        window.HTMLTextAreaElement.prototype,
      ],
    ] as const)
      await act(async () => {
        const input = container.querySelector(`#${id}`)!;
        Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    const tabs = container.querySelectorAll('[role="tab"]');
    for (const index of [0, 1])
      await act(async () => {
        tabs[index]!.dispatchEvent(
          new window.MouseEvent('mousedown', { bubbles: true, button: 0 }),
        );
      });
    assert.equal(
      (
        container.querySelector(
          '#browser-objective',
        ) as unknown as HTMLTextAreaElement
      ).value,
      '查询价格并整理表格',
    );
    await act(async () =>
      form.dispatchEvent(
        new window.Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]!.objective, '查询价格并整理表格');
    await act(async () => {
      form.dispatchEvent(
        new window.Event('submit', { bubbles: true, cancelable: true }),
      );
      form.dispatchEvent(
        new window.Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[1], bodies[0]);
    assert.equal(
      (form.querySelector('button') as unknown as HTMLButtonElement).disabled,
      true,
    );
    await act(async () => reply!(Response.json({ id: bodies[1]!.taskId })));
    assert.equal(window.location.hash, `#/browser-tasks/${bodies[1]!.taskId}`);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});

// 范围：安全 Markdown 结果和终态展示；不验证网页布局或证据下载。
test('浏览器结果展示正文表格与证据，不出现验收通过率', async () => {
  const { createElement: h } = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { BrowserTaskResult } =
    await import('../../apps/console/src/components/browser-task-result.tsx');
  const task = {
    id: 'browser-test',
    state: 'COMPLETED',
    definition: {
      taskKind: 'browser',
      target: { url: 'https://example.test/' },
    },
    report: {
      summary: '结果',
      browserResult: {
        outcome: 'COMPLETED',
        output:
          '| 套餐 | 价格 |\n| --- | --- |\n| 基础 | 10 |\n<script>bad()</script>',
        evidenceRefs: ['evidence'],
      },
      artifacts: [{ id: 'evidence', kind: 'DOM' }],
    },
  };
  const html = renderToStaticMarkup(
    h(BrowserTaskResult, { api: new ApiClient('fixture'), task }),
  );
  assert.match(html, /任务已完成/);
  assert.match(html, /<table>/);
  assert.match(html, /基础/);
  assert.match(html, /evidence/);
  assert.doesNotMatch(html, /验收通过|通过率|<script>/);
  task.state = 'TIMED_OUT';
  assert.match(
    renderToStaticMarkup(
      h(BrowserTaskResult, { api: new ApiClient('fixture'), task }),
    ),
    /任务未完成/,
  );
});
