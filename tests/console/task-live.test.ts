import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import type { TaskDetail } from '../../contracts/src/index.ts';
import { ApiClient } from '../../apps/console/src/api.ts';
import {
  TaskLive,
  TaskExecutionStatus,
} from '../../apps/console/src/components/task-live.tsx';

/** 服务端渲染检查单组页面的状态和入口，不建立 WebSocket 或操作浏览器。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const api = new ApiClient('fixture-only-credential');

/** 夹具只包含这两个组件读取的字段，不代表完整服务端返回或实际登录状态。 */
function task(
  mode: 'AUTO' | 'HUMAN' | 'REQUESTED',
  state = 'RUNNING',
): TaskDetail {
  return {
    state,
    executions: [
      {
        id: 'fixture-execution',
        state: 'RUNNING',
        control_mode: mode,
        control_revision: 1,
        control_reason: '请完成测试账号登录',
        action_count: 2,
      },
    ],
  } as TaskDetail;
}
function render(value: TaskDetail) {
  return renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(TaskExecutionStatus, { task: value }),
      createElement(TaskLive, { api, task: value }),
    ),
  );
}

// 范围：纯单组自动执行也挂载实时画面组件；不验证网络首帧或真实帧内容。
test('单组任务显示浏览器画面及重新连接入口', () => {
  const html = render(task('AUTO'));
  assert.ok(html.includes('浏览器画面'));
  assert.ok(html.includes('等待浏览器首帧'));
  assert.ok(html.includes('重新连接画面'));
  assert.ok(!html.includes('等待人工处理'));
});

// 范围：人工等待和交接使用明确状态，入口位于画面前；不验证处理链接异步请求。
test('人工接管显示顶部待办且不显示自动画面的重连按钮', () => {
  const html = render(task('HUMAN'));
  assert.ok(html.includes('等待人工处理'));
  assert.ok(html.includes('请完成测试账号登录'));
  assert.ok(html.includes('独立处理页查看画面'));
  assert.ok(!html.includes('重新连接画面'));
  assert.ok(html.indexOf('待处理事项') < html.indexOf('comparison-screen'));
  const requested = render(task('REQUESTED'));
  assert.ok(requested.includes('等待执行交接'));
  assert.ok(requested.includes('交接完成后可打开处理页'));
});

// 范围：终态残留 HUMAN 不显示待办，空画面收起，排队无会话不冒充有浏览器；不覆盖缓存帧加载。
test('终态与未分配会话不会误报人工等待', () => {
  const html = render(task('HUMAN', 'CANCELLED'));
  assert.ok(html.includes('已取消'));
  assert.ok(!html.includes('待处理事项'));
  assert.ok(!html.includes('等待人工处理'));
  assert.ok(html.includes('live-screen-empty'));
  const queued = task('AUTO', 'QUEUED');
  queued.executions = [];
  assert.ok(!render(queued).includes('comparison-screen'));
});
