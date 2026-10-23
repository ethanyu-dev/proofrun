import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
import { ApiClient } from '../../apps/console/src/api.ts';
import { TaskDelete } from '../../apps/console/src/components/task-delete.tsx';
import { CaseRunHistory } from '../../apps/console/src/components/case-run-history.tsx';

/** 使用 Console 的 React 与 DOM 夹具；所有 HTTP 均在测试内替换。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement, act } = require('react');

// 范围：确认、冻结批次、失败提示、成功刷新、历史深链接与运行中禁删；不证明真实数据库或视觉布局。
test('软删除确认只提交冻结选择，历史运行链接固定身份', async (context) => {
  const window = new Window({ url: 'http://localhost/#/tasks' });
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
  const api = new ApiClient('fixture');
  const calls: { path: string; body: unknown }[] = [];
  let fail = true;
  let refreshed = 0;
  context.mock.method(
    api,
    'json',
    async (path: string, _signal: AbortSignal, body?: unknown) => {
      calls.push({ path, body });
      if (path.endsWith('/runs'))
        return {
          runs: [
            {
              runId: 'case-run-second',
              taskId: 'case-run-second',
              state: 'RUNNING',
              createdAt: '2026-10-23T01:00:00Z',
              finishedAt: null,
            },
            {
              runId: 'case-v2-stable',
              taskId: 'case-v2-stable',
              state: 'COMPLETED',
              createdAt: '2026-10-22T01:00:00Z',
              finishedAt: '2026-10-22T02:00:00Z',
            },
          ],
        };
      if (fail) throw new Error('会话尚未关闭');
      return { deletedTaskIds: ['one', 'two'] };
    },
  );
  const button = (label: string) =>
    [...container.querySelectorAll('button')].find(
      (b) => b.textContent === label,
    )!;
  const props = {
    api,
    ids: ['one', 'two'],
    onDeleted: () => {
      refreshed++;
    },
  };
  try {
    await act(async () => root.render(createElement(TaskDelete, props)));
    await act(async () => button('删除选中（2）').click());
    assert.equal(calls.length, 0);
    await act(async () =>
      root.render(createElement(TaskDelete, { ...props, ids: ['third'] })),
    );
    await act(async () => button('确认删除').click());
    assert.deepEqual(calls[0], {
      path: '/v1/tasks/delete',
      body: { ids: ['one', 'two'] },
    });
    assert.match(container.textContent!, /会话尚未关闭/);
    assert.equal(refreshed, 0);
    fail = false;
    await act(async () => button('确认删除').click());
    assert.equal(refreshed, 1);
    assert.equal(container.querySelector('.confirm-panel'), null);
    await act(async () =>
      root.render(
        createElement(CaseRunHistory, {
          api,
          caseId: 'stable',
          taskId: 'case-v2-stable',
        }),
      ),
    );
    assert.equal(calls.at(-1)!.path, '/v2/cases/stable/runs');
    assert.match(container.textContent!, /历史运行 · stable（2 次）/);
    assert.ok(container.querySelector('a[href="#/tasks/case-run-second"]'));
    assert.ok(container.querySelector('a[href="#/reports/case-v2-stable"]'));
    const rows = container.querySelectorAll('li');
    assert.equal(rows[0]!.querySelector('button')!.disabled, true);
    assert.equal(rows[1]!.querySelector('button')!.disabled, false);
    assert.match(rows[1]!.textContent!, /当前查看/);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
