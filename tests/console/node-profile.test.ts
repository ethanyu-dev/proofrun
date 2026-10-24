import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { HitlPage } from '../../apps/console/src/pages/hitl.tsx';

/** 使用真实 React 组件进行静态检查，连接行为由独立 WS 夹具核实。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// 范围：任务人工操作页面只提供交还与无法处理；静态渲染不验证远端浏览器或交接时序。
test('人工处理入口不再提供 profile 保存与维护', () => {
  const html = renderToStaticMarkup(
    createElement(HitlPage, { id: 'fixture', token: 'fixture-token' }),
  );
  assert.match(html, />完成，继续任务</);
  assert.match(html, />无法处理</);
  assert.match(html, /前往远端网址/);
  assert.doesNotMatch(html, /保存并关闭|保存基准|默认模板/);
});

// 范围：失败展示区别租约过期、正常关闭和已保存；静态渲染不验证远端浏览器或轮询时序。
test('维护结果显示具体失败码且不暗示旧模板丢失', async () => {
  const { NodeProfileOutcome } =
    await import('../../apps/console/src/components/node-profile-outcome.tsx');
  const status = {
    ready: false,
    closed: true,
    closing: true,
    saveStatus: null,
    failure: {
      code: 'SESSION_LEASE_EXPIRED',
      errorCode: 'DEADLINE_EXCEEDED',
      closeReason: 'SESSION_LEASE_EXPIRED',
      message: '节点未能在租约到期前完成续租，浏览器已停止。',
    },
  };
  const html = renderToStaticMarkup(
    createElement(NodeProfileOutcome, { status, closing: false }),
  );
  assert.match(html, /维护会话失败/);
  assert.match(html, /SESSION_LEASE_EXPIRED/);
  assert.match(html, /DEADLINE_EXCEEDED/);
  assert.match(html, /之前已保存的模板不会因此被删除/);
  assert.match(html, /维护入口已停用/);
  const normal = renderToStaticMarkup(
    createElement(NodeProfileOutcome, {
      status: { ...status, failure: null },
      closing: false,
    }),
  );
  assert.doesNotMatch(normal, /维护会话失败|错误码/);
  const saved = renderToStaticMarkup(
    createElement(NodeProfileOutcome, {
      status: { ...status, saveStatus: 'saved' },
      closing: false,
    }),
  );
  assert.match(saved, /本次节点默认 profile 已保存/);
  assert.doesNotMatch(saved, /本次没有确认发布/);
});

// 范围：关闭后原因尚未同步时明确提示等待；静态渲染不替代浏览器轮询回归。
test('关闭确认与最终失败诊断分开展示', async () => {
  const { NodeProfileOutcome } =
    await import('../../apps/console/src/components/node-profile-outcome.tsx');
  const status = {
    ready: false,
    closed: true,
    closing: true,
    saveStatus: null,
    failureDetailsPending: true,
    failure: {
      code: 'COMMAND_DEADLINE_EXCEEDED',
      errorCode: 'COMMAND_DEADLINE_EXCEEDED',
      closeReason: null,
      message: '浏览器命令未在规定时间内返回结果。',
    },
  };
  const provisional = renderToStaticMarkup(
    createElement(NodeProfileOutcome, { status, closing: false }),
  );
  assert.match(provisional, /正在同步节点最终失败原因/);
  assert.match(provisional, /浏览器已关闭/);
  const final = renderToStaticMarkup(
    createElement(NodeProfileOutcome, {
      status: { ...status, failureDetailsPending: false },
      closing: false,
    }),
  );
  assert.doesNotMatch(final, /正在同步/);
});
