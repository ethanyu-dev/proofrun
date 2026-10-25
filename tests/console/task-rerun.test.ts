import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { ApiClient } from '../../apps/console/src/api.ts';
import { rerunTask } from '../../apps/console/src/components/task-rerun-request.ts';
import { TaskRerun } from '../../apps/console/src/components/task-rerun.tsx';

/** 使用 Console 自身 React 渲染按钮，不启动浏览器或真实业务执行。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const api = new ApiClient('rerun-test-credential');

// 范围：任一组按 case 身份调用新接口，重试复用新身份并跳转主组；请求由夹具接收，不证明服务端幂等。
test('结构化重跑保持 case 身份并跳转到新的运行', async (context) => {
  const calls: { path: unknown; body: unknown }[] = [];
  context.mock.method(
    globalThis,
    'fetch',
    async (path: unknown, init: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json({
        caseId: 'old',
        taskId: 'case-run-new-case',
        comparison: {
          arms: [
            { taskId: 'case-run-new-case' },
            { taskId: 'comparison-case-run-new-case-jev' },
          ],
        },
      });
    },
  );
  for (let i = 0; i < 2; i++)
    assert.equal(
      await rerunTask(
        api,
        'comparison-case-v2-old-jev',
        'new-case',
        new AbortController().signal,
        'old',
        { mode: 'guest' },
      ),
      'case-run-new-case',
    );
  assert.deepEqual(
    calls,
    Array(2).fill({
      path: '/v2/cases/old/rerun',
      body: { runId: 'new-case', session: { mode: 'guest' } },
    }),
  );
  const html = renderToStaticMarkup(
    createElement(TaskRerun, { api, id: 'jev', caseId: 'old' }),
  );
  assert.match(html, /重跑整个 case/);
});

// 范围：单组 case 跳转和普通任务旧接口兼容；不执行真实重跑或验证浏览器点击事件。
test('单组 case 与普通任务保留各自重跑路径', async (context) => {
  const paths: unknown[] = [];
  context.mock.method(globalThis, 'fetch', async (path: unknown) => {
    paths.push(path);
    return Response.json(
      String(path).startsWith('/v2/')
        ? { caseId: 'old', taskId: 'case-run-single' }
        : { taskId: 'ordinary-new' },
    );
  });
  const signal = new AbortController().signal;
  assert.equal(
    await rerunTask(api, 'case-v2-old', 'single', signal, 'old'),
    'case-run-single',
  );
  assert.equal(
    await rerunTask(api, 'ordinary', 'ordinary-new', signal),
    'ordinary-new',
  );
  assert.deepEqual(paths, ['/v2/cases/old/rerun', '/v1/tasks/ordinary/rerun']);
});
