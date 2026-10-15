import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import {
  identityWrite,
  type IdentitySettingsView,
} from '../../apps/console/src/identity-config.ts';
import { IdentityForm } from '../../apps/console/src/pages/identities.tsx';
import { IdentityUsage } from '../../apps/console/src/components/identity-overview.tsx';
import { ApiClient } from '../../apps/console/src/api.ts';

/** 组件使用实际 React 服务端渲染；交互另外通过浏览器和真实测试 API 检查。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const settings: IdentitySettingsView = {
  revision: 3,
  mode: 'http',
  source: 'http',
  url: 'https://identities.example.test/catalog',
  tokenConfigured: true,
  catalog: null,
  updatedAt: '2026-10-11T00:00:00Z',
};

// 范围：模式切换的请求正文与令牌省略语义；不模拟令牌文件权限或外部提供方。
test('非外部模式不携带表单旧令牌，空令牌表示保留且站点输入规范化', () => {
  const catalog = {
    identities: [
      {
        id: 'member',
        label: '成员',
        accountKey: 'member',
        origins: [' https://example.test ', ''],
        checks: [],
        maxConcurrent: 1,
      },
    ],
    pools: [],
    sites: [],
  };
  assert.deepEqual(
    identityWrite(3, 'environment', 'unused', 'secret', catalog),
    { revision: 3, mode: 'environment' },
  );
  const local = identityWrite(3, 'local', 'unused', 'secret', catalog);
  assert.ok(!JSON.stringify(local).includes('secret'));
  assert.deepEqual(local.catalog?.identities[0]?.origins, [
    'https://example.test',
  ]);
  assert.deepEqual(
    identityWrite(3, 'http', ' https://example.test ', '', catalog),
    { revision: 3, mode: 'http', url: 'https://example.test' },
  );
  assert.equal(
    identityWrite(3, 'http', 'https://example.test', 'new-token', catalog)
      .token,
    'new-token',
  );
});

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

// 范围：无准备回执显示暂无数据，账号占用和等待分别表达；不验证统计 SQL。
test('身份统计不把暂无准备记录显示为零成功率或验收失败', () => {
  const html = renderToStaticMarkup(
    createElement(IdentityUsage, {
      metrics: {
        windowDays: 30,
        completedPreparations: 0,
        automaticReady: 0,
        automaticReadyRate: null,
        waitingForIdentity: 2,
        accounts: [{ accountKey: 'physical', occupied: 1, capacity: 1 }],
        attempts: [],
        hitl: [],
      },
    }),
  );
  assert.match(html, /暂无数据/);
  assert.match(html, /2 个任务/);
  assert.match(html, /1 \/ 1/);
  assert.doesNotMatch(html, /0\.0%/);
});
