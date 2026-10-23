import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { IdentityForm } from '../../apps/console/src/pages/identities.tsx';
import { ApiClient } from '../../apps/console/src/api.ts';

/** 组件使用实际 React 服务端渲染；本文件不覆盖浏览器交互或 HTTP 保存。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
// 范围：真实 React 静态渲染六字段表单及敏感值省略；不覆盖浏览器输入与 HTTP 保存。
test('身份表单只呈现六个账号字段，不要求内部引用', () => {
  const html = renderToStaticMarkup(
    createElement(IdentityForm, {
      api: new ApiClient('fixture'),
      saved() {},
      cancel() {},
    }),
  );
  for (const label of [
    '测试地址',
    '身份名称',
    '身份类型（可选）',
    '并发数',
    '身份描述',
    'Cookies',
  ])
    assert.ok(html.includes(label));
  assert.match(html, /Cookie 1 Name/);
  assert.match(html, /Cookie 1 Value/);
  assert.match(html, /role="switch" aria-checked="true"/);
  for (const label of [
    '账号键',
    '登录配方引用',
    '节点 ID',
    '快照 ID',
    '站点规则',
    '配置来源',
  ])
    assert.ok(!html.includes(label));
});
