import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { ApiClient } from '../../apps/console/src/api.ts';
import { TaskSubmitPage } from '../../apps/console/src/pages/task-submit.tsx';
import { TaskFields } from '../../apps/console/src/components/task-fields.tsx';
import { newTaskDefinition } from '../../apps/console/src/task-definition.ts';
import { submitCaseBatch } from '../../apps/console/src/components/task-submit-request.ts';
import type { VerificationCaseV2 } from '../../contracts/src/index.ts';

/** 使用控制台实际 React 依赖检查初始页面，不加载浏览器或调用服务端。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// 范围：新建 v1 表单不暴露已退役的快照保存/恢复开关；不验证真实身份注入和人工交还。
test('任务表单只提供临时会话和人工授权，不再配置登录快照', () => {
  const task = newTaskDefinition();
  const html = renderToStaticMarkup(
    createElement(TaskFields, { task, change() {} }),
  );
  assert.match(html, /允许人工辅助/);
  assert.match(html, /独立临时浏览器/);
  assert.doesNotMatch(
    html,
    /自动复用本站登录状态|使用节点登录状态|恢复已有登录状态|登录状态名称/,
  );
  assert.equal(task.environment.reuseAuth, undefined);
  assert.equal(task.environment.auth, undefined);
});

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
  for (const label of [
    '使用 LLM 单组执行',
    '按测试身份来源准备独立会话',
    '人工辅助由平台配置授权',
  ])
    assert.ok(html.includes(label));
});
