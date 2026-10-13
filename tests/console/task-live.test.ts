import { FollowUpCleanup } from '../../apps/console/src/components/follow-up-cleanup.tsx';
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

// 范围：环境不符合独立展示，不冒充产品失败或残留人工等待；不覆盖真实浏览器和网络。
test('准备不符合要求时展示不符合验证环境', () => {
  const value = task('AUTO', 'COMPLETED');
  value.report = {
    executionDetails: { reasonCode: 'ENVIRONMENT_NOT_READY' },
  } as TaskDetail['report'];
  const html = render(value);
  assert.ok(html.includes('不符合验证环境'));
  assert.ok(!html.includes('等待人工处理'));
});

/** 同一任务含不同的业务阻塞和清理截图，检验页面不能用最后清理图覆盖业务现场。 */
function blockedTask(): TaskDetail {
  const value = task('AUTO', 'COMPLETED');
  value.definition = {
    cleanupStepIds: ['cleanup'],
    acceptanceCriteria: [],
    steps: [
      {
        stepId: 'setup',
        type: 'setup',
        description: '准备账号',
        policy: [],
        expected: [],
      },
      {
        stepId: 'cleanup',
        type: 'setup',
        description: '退出登录',
        policy: [],
        expected: [],
      },
    ],
  } as TaskDetail['definition'];
  value.report = {
    artifacts: ['blocked-image', 'cleanup-image', 'later-image'].map((id) => ({
      id,
      kind: 'SCREENSHOT',
      sha256: 'a'.repeat(64),
      uri: `/v1/artifacts/${id}`,
    })),
    steps: [
      {
        stepId: 'setup',
        status: 'BLOCKED',
        summary: '登录成功，GitHub 绑定状态未确认',
        criteria: [],
        evidenceRefs: ['blocked-image', 'later-image'],
        startedAt: '2026-10-13T02:07:00Z',
        finishedAt: '2026-10-13T02:08:00Z',
        blockage: {
          recordedAt: '2026-10-13T02:08:00Z',
          evidenceRefs: ['blocked-image'],
          conditions: [
            {
              id: 'binding',
              description: 'GitHub 未绑定',
              summary: '尚未进入设置页核实',
              status: 'UNCONFIRMED',
            },
          ],
        },
      },
      {
        stepId: 'cleanup',
        status: 'COMPLETED',
        summary: '已退出',
        criteria: [],
        evidenceRefs: ['cleanup-image'],
        startedAt: '2026-10-13T02:08:01Z',
        finishedAt: '2026-10-13T02:09:00Z',
      },
    ],
  } as TaskDetail['report'];
  return value;
}

// 范围：终态选用冻结截图及具体条件，清理证据独立展示；SSR 不验证图片下载或浏览器像素。
test('阻塞截图与清理截图分开，主画面不使用最后一帧', () => {
  const value = blockedTask();
  const html = render(value);
  assert.match(html, /阻塞时截图/);
  assert.match(html, /blocked-image/);
  assert.match(html, /尚未进入设置页核实/);
  assert.ok(!html.includes('cleanup-image'));
  assert.ok(!html.includes('later-image'));
  assert.ok(!html.includes('comparison-screen'));
  const cleanup = renderToStaticMarkup(
    createElement(FollowUpCleanup, { api, task: value }),
  );
  assert.match(cleanup, /清理截图/);
  assert.match(cleanup, /cleanup-image/);
  assert.ok(!cleanup.includes('blocked-image'));
});

// 范围：旧报告无冻结快照时仅回退到同一步证据，不混用 cleanup；不补造历史拍摄时间。
test('历史报告回退到阻塞步骤截图并说明来源', () => {
  const value = blockedTask();
  delete value.report!.steps![0]!.blockage;
  const html = render(value);
  assert.match(html, /阻塞步骤最后记录的截图/);
  assert.match(html, /later-image/);
  assert.ok(!html.includes('cleanup-image'));
});

// 范围：无截图明确展示取证限制，已归档证据不可预览；不伪造新截图。
test('截图缺失或归档时保留原因，不以清理图兜底', () => {
  const value = blockedTask();
  value.report!.steps![0]!.blockage!.evidenceRefs = [];
  value.report!.steps![0]!.blockage!.screenshotError = 'SCREENSHOT_UNAVAILABLE';
  const html = render(value);
  assert.match(html, /未取得可展示的阻塞截图/);
  assert.match(html, /SCREENSHOT_UNAVAILABLE/);
  assert.ok(!html.includes('cleanup-image'));
  const archived = blockedTask();
  archived.archived_at = '2026-10-13T03:00:00Z';
  assert.match(render(archived), /证据已清理/);
});
