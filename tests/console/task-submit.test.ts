import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { ApiClient } from '../../apps/console/src/api.ts';
import { TaskSubmitPage } from '../../apps/console/src/pages/task-submit.tsx';
import { submitCaseBatch } from '../../apps/console/src/components/task-submit-request.ts';
import type { VerificationCaseV2 } from '../../contracts/src/index.ts';

/** 使用控制台实际 React 依赖检查初始页面，不加载浏览器或调用服务端。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// 范围：受控响应验证提交正文、单 case 双跑/单组跳转和批量返回列表；不覆盖真实 API 或浏览器导航。
test('单个 v2 case 提交后直达任务详情，批量保留列表入口', async (context) => {
  const cases: VerificationCaseV2[] = [
    {
      caseId: 'fixture-submit',
      platform: '夹具',
      entry: 'https://example.test',
      steps: [
        {
          type: 'verification',
          url: 'https://example.test',
          exec_order: 1,
          description: '检查夹具',
          policy: [],
          expected: ['显示夹具'],
        },
      ],
      cleanup: [],
    },
  ];
  let response: unknown = [
    {
      caseId: cases[0]!.caseId,
      comparison: {
        arms: [{ taskId: 'server-primary' }, { taskId: 'server-secondary' }],
      },
    },
  ];
  context.mock.method(
    globalThis,
    'fetch',
    async (path: unknown, init: RequestInit) => {
      assert.equal(path, '/v2/cases');
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(String(init.body)), cases);
      return Response.json(response);
    },
  );
  const api = new ApiClient('fixture');
  const signal = new AbortController().signal;
  assert.equal(
    await submitCaseBatch(api, cases, signal),
    '/tasks/server-primary',
  );
  response = [{ caseId: cases[0]!.caseId }];
  assert.equal(
    await submitCaseBatch(api, cases, signal),
    '/tasks/case-v2-fixture-submit',
  );
  cases.push({ ...cases[0]!, caseId: 'fixture-second' });
  response = cases.map(({ caseId }) => ({ caseId }));
  assert.equal(await submitCaseBatch(api, cases, signal), '/tasks');
});

// 范围：默认显示 v2 粘贴入口与三项默认行为，保留 v1 入口；不证明点击提交或业务执行成功。
test('提交页默认只要求粘贴 v2 JSON', () => {
  const html = renderToStaticMarkup(
    createElement(TaskSubmitPage, { api: new ApiClient('fixture') }),
  );
  assert.match(html, /aria-pressed="true"[^>]*>v2 Schema 提交/);
  assert.match(html, /v1 兼容入口/);
  assert.match(html, /id="case-definition"/);
  assert.equal((html.match(/<textarea/g) ?? []).length, 1);
  assert.doesNotMatch(html, /任务目标|验收项 ID|最大动作次数/);
  for (const label of ['双跑模式', '自动复用本站登录状态', '允许人工辅助'])
    assert.ok(html.includes(label));
});
