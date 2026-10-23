import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { ApiClient } from '../../apps/console/src/api.ts';
import { TaskSubmitPage } from '../../apps/console/src/pages/task-submit.tsx';

/** 使用控制台实际 React 依赖检查初始页面，不加载浏览器或调用服务端。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// 范围：仅显示 v2 粘贴入口与三项默认行为，移除内部入口；不证明点击提交或业务执行成功。
test('提交页默认只要求粘贴 v2 JSON', () => {
  const html = renderToStaticMarkup(
    createElement(TaskSubmitPage, { api: new ApiClient('fixture') }),
  );
  assert.match(html, /v2 Schema JSON/);
  assert.doesNotMatch(
    html,
    /内部任务入口|提交版本|任务编辑模式|表单模式|JSON 模式|task-definition/,
  );
  assert.match(html, /id="case-definition"/);
  assert.equal((html.match(/<textarea/g) ?? []).length, 1);
  assert.doesNotMatch(html, /任务目标|验收项 ID|最大动作次数/);
  for (const label of [
    '默认使用 LLM + JEV 单组执行',
    '自动复用本站登录状态',
    '允许人工辅助',
  ])
    assert.ok(html.includes(label));
});
