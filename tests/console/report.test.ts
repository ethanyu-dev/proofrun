import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { TaskDetail } from '../../contracts/src/index.ts';
import { summarizeReport } from '../../contracts/src/report-status.ts';
import { ApiClient } from '../../apps/console/src/api.ts';
import { ReportDetails } from '../../apps/console/src/pages/report-detail.tsx';
import { TaskResources } from '../../apps/console/src/components/task-sections.tsx';
import { ReportExport } from '../../apps/console/src/components/report-export.tsx';

/** 静态渲染只核对信息层级和身份，不执行浏览器请求或模型验收。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const api = new ApiClient('fixture-report-only');

/** 同时包含通过、失败与缺项，确保排序、未覆盖统计不会被单一结论掩盖。 */
function fixture(): TaskDetail {
  const report: NonNullable<TaskDetail['report']> = {
    protocolVersion: '0.1',
    taskId: 'report-fixture',
    lifecycle: 'COMPLETED',
    executionDisposition: 'EXECUTED',
    verdict: 'FAILED',
    summary: '一项未满足要求',
    criteria: [
      {
        criterionId: 'passed',
        verdict: 'PASSED',
        summary: '已观察到预期内容',
        evidenceRefs: ['network'],
      },
      {
        criterionId: 'failed',
        verdict: 'FAILED',
        summary: '本次观察与预期不同',
        evidenceRefs: ['network'],
      },
    ],
    artifacts: [
      {
        id: 'network',
        kind: 'NETWORK',
        uri: 'https://example.test/network',
        sha256: 'a'.repeat(64),
      },
    ],
  };
  return {
    id: 'report-fixture',
    state: 'COMPLETED',
    created_at: '2026-10-09T00:00:00Z',
    finished_at: '2026-10-09T00:01:00Z',
    deadline_at: '2026-10-09T00:05:00Z',
    error: null,
    archived_at: null,
    executions: [],
    report,
    ...summarizeReport(report, ['passed', 'failed', 'missing']),
    definition: {
      protocolVersion: '0.1',
      taskId: 'report-fixture',
      objective: '报告展示夹具',
      target: { url: 'https://example.test' },
      environment: { id: 'fixture', nodePool: 'fixture' },
      budget: { timeoutMs: 10000, maxActions: 10 },
      acceptanceCriteria: ['passed', 'failed', 'missing'].map((id) => ({
        id,
        description: `${id} 验收要求`,
        expectedResult: `${id} 预期内容`,
        evidenceKinds: ['NETWORK'],
      })) as TaskDetail['definition']['acceptanceCriteria'],
    },
  };
}

// 范围：失败优先、通过收起、缺项不伪造观察、证据类型准确；不覆盖客户端展开和异步预览。
test('独立报告按结论和证据组织，并保留未覆盖范围', () => {
  const html = renderToStaticMarkup(
    createElement(ReportDetails, { api, task: fixture() }),
  );
  assert(html.indexOf('failed 验收要求') < html.indexOf('passed 验收要求'));
  assert.match(html, /1 项尚未得出结论/);
  assert.match(html, /本次报告未提供此项观察和判定/);
  assert.match(html, /网络记录/);
  assert.match(
    html,
    /<details class="report-criterion"><summary>.*?passed 验收要求/,
  );
  assert.match(html, /href="#\/tasks\/report-fixture"/);
  assert(!html.includes('取消任务'));
});

// 范围：证据已清理时禁止点击但保留报告，无报告的终态不能显示验收失败；不验证后端保留策略。
test('证据清理与报告未生成具有明确的独立状态', () => {
  const task = fixture();
  task.archived_at = '2026-10-09T01:00:00Z';
  const archived = renderToStaticMarkup(
    createElement(ReportDetails, { api, task }),
  );
  assert.match(archived, /证据不可预览或下载/);
  assert.match(archived, /report-evidence-button" disabled/);
  task.report = null;
  task.reportStatus = null;
  task.criteriaCounts = null;
  task.state = 'ERROR';
  const missing = renderToStaticMarkup(
    createElement(ReportDetails, { api, task }),
  );
  assert.match(missing, /尚未生成验证报告/);
  assert(!missing.includes('未通过'));
});

// 范围：导出含统一状态与统计且保留原报告字段；不覆盖浏览器下载或剪贴板权限。
test('报告导出携带与接口一致的状态和统计', () => {
  const task = fixture();
  const html = renderToStaticMarkup(
    createElement(ReportExport, {
      report: task.report!,
      assessment: task,
      close() {},
    }),
  );
  assert.match(html, /reportStatus/);
  assert.match(html, /criteriaCounts/);
  assert.match(html, /executionDisposition/);
});

// 范围：静态渲染区分最近诊断与终态历史原因，兼容旧记录；不验证轮询和真实节点可用性。
test('任务资源区在排队和结束后展示调度诊断', () => {
  const task = fixture();
  task.state = 'QUEUED';
  task.queueReason = {
    code: 'AUTH_NODE_ROUTE_CONFLICT',
    message: '显式登录节点与域名路由不一致。',
  };
  let html = renderToStaticMarkup(createElement(TaskResources, { task }));
  assert.match(html, /最近一次排队原因/);
  assert.match(html, /显式登录节点与域名路由不一致/);
  task.state = 'TIMED_OUT';
  html = renderToStaticMarkup(createElement(TaskResources, { task }));
  assert.match(html, /结束前最后一次排队原因/);
  delete task.queueReason;
  html = renderToStaticMarkup(createElement(TaskResources, { task }));
  assert(!html.includes('排队原因'));
});
