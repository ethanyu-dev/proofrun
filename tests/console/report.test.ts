import { FollowUpCleanup } from '../../apps/console/src/components/follow-up-cleanup.tsx';
import { StepCompletion } from '../../apps/console/src/components/step-completion.tsx';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { TaskDetail } from '../../contracts/src/index.ts';
import { summarizeReport } from '../../contracts/src/report-status.ts';
import { ApiClient } from '../../apps/console/src/api.ts';
import { ReportDetails } from '../../apps/console/src/pages/report-detail.tsx';
import {
  TaskReport,
  TaskResources,
} from '../../apps/console/src/components/task-sections.tsx';
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
  assert.doesNotMatch(html, /report-counts/);
  assert.doesNotMatch(html, /一项未满足要求/);
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

// 范围：完成情况区分执行失败、验收不通过和未执行，清理不计入业务验收；静态渲染不验证浏览器交互。
test('case 完成情况逐项列出业务、前置和清理，不把失败说成未执行', () => {
  const task = fixture();
  task.state = 'ERROR';
  task.report = null;
  const step = {
    stepId: 'check-1',
    url: 'https://example.test',
    type: 'verification' as const,
    exec_order: 1,
    description: '业务检查',
    policy: [],
    expected: ['正确'],
  };
  task.definition.steps = [
    step,
    ...[2, 3, 4].map((i) => ({ ...step, stepId: `check-${i}` })),
    { ...step, stepId: 'cleanup-1', type: 'setup', expected: [] },
  ];
  task.definition.acceptanceCriteria = [1, 2, 3, 4].map((i) => ({
    id: i === 1 ? 'failed' : `criterion-${i}`,
    stepId: `check-${i}`,
    description: '业务检查',
    expectedResult: `要求 ${i}`,
    evidenceKinds: ['DOM'],
  }));
  task.definition.cleanupStepIds = ['cleanup-1'];
  task.stepResults = (
    ['COMPLETED', 'BLOCKED', 'ERROR', 'PENDING', 'COMPLETED'] as const
  ).map((status, i) => ({
    stepId: i === 4 ? 'cleanup-1' : `check-${i + 1}`,
    status,
    summary: status === 'BLOCKED' ? '缺少团队身份' : '夹具结果',
    criteria:
      i === 0
        ? [
            {
              criterionId: 'failed',
              verdict: 'FAILED',
              summary: '未满足',
              evidenceRefs: [],
            },
          ]
        : [],
    evidenceRefs: [],
    startedAt: null,
    finishedAt: null,
  }));
  const html = renderToStaticMarkup(
    createElement(StepCompletion, { api, task }),
  );
  assert.match(html, /验证汇总/);
  assert.doesNotMatch(html, /本 case 完成情况|cleanup-1/);
  for (const text of [
    'check-1',
    'check-2',
    'check-3',
    'check-4',
    '未通过',
    '未验收',
    '缺少团队身份',
    '未执行',
  ])
    assert(html.includes(text), text);
  assert(!html.includes('等待执行'));
  assert.match(
    renderToStaticMarkup(createElement(FollowUpCleanup, { api, task })),
    /清理结果：未确认/,
  );
});

/** 清理夹具只提供存档数据，不能证明真实浏览器已退出或 Cookie 已清除。 */
function cleanupFixture(): TaskDetail {
  const task = fixture();
  task.definition.steps = [
    {
      stepId: 'cleanup-1',
      type: 'setup',
      exec_order: 1,
      url: 'https://example.test',
      description: '退出并清除登录态',
      policy: [],
      expected: ['登录态已清除'],
    },
  ];
  task.definition.cleanupStepIds = ['cleanup-1'];
  task.definition.acceptanceCriteria = [
    {
      id: 'cleanup-check',
      stepId: 'cleanup-1',
      description: '核对清理',
      expectedResult: '登录态已清除',
      evidenceKinds: ['NETWORK'],
    },
  ];
  task.report!.steps = [
    {
      stepId: 'cleanup-1',
      status: 'COMPLETED',
      summary: '清理执行记录',
      evidenceRefs: ['network'],
      startedAt: null,
      finishedAt: null,
      criteria: [
        {
          criterionId: 'cleanup-check',
          verdict: 'PASSED',
          summary: '清理效果观察',
          evidenceRefs: ['network'],
        },
      ],
    },
  ];
  return task;
}

// 范围：清理确认须有完整验收及匹配类型的证据，旧记录和缺失项不能误判通过；不验证证据内容真实性。
test('清理结果区分执行完成与效果确认，并保留可核对的证据', () => {
  const task = cleanupFixture();
  const render = () =>
    renderToStaticMarkup(createElement(FollowUpCleanup, { api, task }));
  assert.match(render(), /清理结果：已确认/);
  assert.match(render(), /网络记录/);
  assert.match(render(), /清理执行记录/);
  assert.match(render(), /清理效果观察/);
  task.archived_at = '2026-10-10T00:00:00Z';
  assert.match(render(), /清理结果：已确认/);
  assert.match(render(), /证据已清理/);
  task.archived_at = null;
  task.report!.artifacts = [];
  assert.match(render(), /清理结果：未确认/);
  task.report!.artifacts = fixture().report!.artifacts;
  task.definition.acceptanceCriteria[0].evidenceKinds = ['DOM'];
  assert.match(render(), /清理结果：未确认/);
  task.definition.acceptanceCriteria[0].evidenceKinds = ['NETWORK'];
  task.report!.steps![0].criteria = [];
  assert.match(render(), /清理结果：未确认/);
  task.definition.steps![0].expected = [];
  task.definition.acceptanceCriteria = [];
  assert.match(render(), /清理结果：未确认/);
  assert.doesNotMatch(render(), /不适用/);
});

// 范围：验收失败、执行异常、受阻和未执行分别保留原因；不执行真实清理动作。
test('清理失败与受阻不被执行状态或缺失验收覆盖', () => {
  const task = cleanupFixture();
  const result = task.report!.steps![0];
  const render = () =>
    renderToStaticMarkup(createElement(FollowUpCleanup, { api, task }));
  result.criteria[0].verdict = 'FAILED';
  assert.match(render(), /清理结果：失败/);
  assert.match(render(), /清理验收项未通过/);
  result.criteria = [];
  result.status = 'ERROR';
  assert.match(render(), /清理结果：失败/);
  result.status = 'BLOCKED';
  assert.match(render(), /清理结果：未确认/);
  assert.match(render(), /清理受阻/);
  result.status = 'PENDING';
  assert.match(render(), /未执行/);
  assert.match(render(), /清理结果：未确认/);
});

// 范围：两种模式及旧记录在报告顶部、任务内报告和 JSON 导出中一致；不验证真实模型调用链。
test('报告明显展示验证模式，导出保留模式编码和文案', () => {
  for (const mode of ['jev', 'llm', undefined] as const) {
    const task = fixture();
    task.definition.executionMode = mode;
    const label = mode === 'jev' ? 'JEV + LLM' : '纯 LLM';
    const html = renderToStaticMarkup(
      createElement(ReportDetails, { api, task }),
    );
    assert(html.includes(`验证模式：${label}`));
    assert(html.indexOf(`验证模式：${label}`) < html.indexOf('逐项验收'));
    const inline = renderToStaticMarkup(
      createElement(TaskReport, { api, task }),
    );
    assert(inline.includes(`验证模式：${label}`));
    const exported = renderToStaticMarkup(
      createElement(ReportExport, {
        report: task.report!,
        assessment: task,
        close() {},
      }),
    );
    const json = JSON.parse(
      exported
        .match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)![1]
        .replaceAll('&quot;', '"')
        .replaceAll('&amp;', '&'),
    );
    assert.equal(json.executionMode, mode ?? 'llm');
    assert.equal(json.executionModeLabel, label);
    assert.equal(json.taskId, task.id);
  }
});

// 范围：步骤到验收项逐一对应，清理单列且顶部无重复计数、摘要；静态渲染不执行真实验收。
test('验证汇总列全验收项，细节和后续清理分开呈现', () => {
  const task = cleanupFixture();
  const cleanup = task.definition.steps![0];
  const cleanResult = task.report!.steps![0];
  task.definition.steps = [
    {
      ...cleanup,
      stepId: 'step-1',
      description: '准备团队账号',
      expected: [],
      policy: ['非所有者身份'],
    },
    {
      ...cleanup,
      stepId: 'step-2',
      type: 'verification',
      description: '检查提示',
      expected: ['提示为中文', '标题为中文'],
    },
    cleanup,
  ];
  task.definition.acceptanceCriteria.unshift(
    {
      id: 'check-a',
      stepId: 'step-2',
      description: '检查提示',
      expectedResult: '提示为中文',
      evidenceKinds: ['NETWORK'],
    },
    {
      id: 'check-b',
      stepId: 'step-2',
      description: '检查提示',
      expectedResult: '标题为中文',
      evidenceKinds: ['NETWORK'],
    },
  );
  const fullReason =
    '前置条件未满足。' + '这是需要在详情中保留的说明。'.repeat(12);
  task.report!.steps = [
    {
      ...cleanResult,
      stepId: 'step-1',
      status: 'BLOCKED',
      summary: fullReason,
      criteria: [],
    },
    {
      ...cleanResult,
      stepId: 'step-2',
      criteria: [
        {
          criterionId: 'check-a',
          verdict: 'PASSED',
          summary: '中文提示',
          evidenceRefs: ['network'],
        },
        {
          criterionId: 'check-b',
          verdict: 'FAILED',
          summary: '标题仍为英文',
          evidenceRefs: ['network'],
        },
      ],
    },
    cleanResult,
  ];
  task.report!.criteria = task.report!.steps.flatMap((s) => s.criteria);
  const summary = renderToStaticMarkup(createElement(StepCompletion, { task }));
  for (const text of [
    '验证汇总',
    'step-1',
    'step-2',
    '非所有者身份',
    '未配置独立验收项',
    'check-a',
    'check-b',
    '提示为中文',
    '标题为中文',
    '通过',
    '未通过',
    '标题仍为英文',
  ])
    assert(summary.includes(text), text);
  assert(!summary.includes(fullReason));
  assert(!summary.includes('cleanup-1'));
  const html = renderToStaticMarkup(
    createElement(ReportDetails, { api, task }),
  );
  assert(html.includes(fullReason));
  assert(html.indexOf('验证汇总') < html.indexOf('逐项验收'));
  assert(html.indexOf('逐项验收') < html.indexOf('后续清理'));
  const businessDetails = html.slice(
    html.indexOf('aria-label="逐项验收"'),
    html.indexOf('aria-label="后续清理"'),
  );
  assert(!businessDetails.includes('cleanup-check'));
  assert(!businessDetails.includes('cleanup-1'));
  assert(!html.includes('report-counts'));
  assert(!html.includes('本 case 完成情况'));
});
