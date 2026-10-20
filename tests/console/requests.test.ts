import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { RequestResultV2 } from '@proofrun/contracts';
import { ApiClient } from '../../apps/console/src/api.ts';
import { parseVerificationRequest } from '../../apps/console/src/task-definition.ts';
import { submitVerificationRequest } from '../../apps/console/src/components/task-submit-request.ts';
import { RequestCasePreview } from '../../apps/console/src/components/request-preview.tsx';
import {
  caseVerificationProgress,
  displayedCaseArm,
} from '../../apps/console/src/request-presentation.ts';
import { RequestCases } from '../../apps/console/src/components/request-cases.tsx';
import { RequestTaskCases } from '../../apps/console/src/components/request-task-cases.tsx';
import { RequestDetailPage } from '../../apps/console/src/pages/request-detail.tsx';

/** 使用真实组件静态渲染；交互和布局另由浏览器检查覆盖。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const CASE = {
  platform: '夹具',
  entry: 'https://example.test',
  steps: [
    {
      type: 'verification',
      url: 'https://example.test',
      exec_order: 1,
      description: '检查',
      policy: [],
      expected: ['显示'],
    },
  ],
  cleanup: [],
};

// 范围：任务页保留目标、步骤、进度及分阶段观看入口，报告页保留结论；静态夹具不验证真实视频连接、执行或操作权限。
test('任务与报告分别承载目标进度和验收结果', () => {
  const steps = [
    { stepId: 'setup', type: 'setup', description: '准备登录', cleanup: false },
    {
      stepId: 'verify',
      type: 'verification',
      description: '检查页面',
      cleanup: false,
    },
    {
      stepId: 'cleanup',
      type: 'setup',
      description: '恢复数据',
      cleanup: true,
    },
  ].map((step) => ({ ...step, expected: [] }));
  const value = {
    requestId: 'split-request',
    cases: [
      {
        caseId: 'split-case',
        title: '分区夹具',
        executionOrigin: 'created',
        steps,
        criteria: [
          {
            criterionId: 'c',
            stepId: 'verify',
            expectedResult: '显示预期标题',
            description: '检查标题',
          },
        ],
        arms: ['llm', 'jev'].map((mode) => ({
          taskId: `split-${mode}`,
          executionMode: mode,
          createdAt: '2026-10-20T00:00:00Z',
          result: {
            status: 'COMPLETED',
            reportStatus: 'FAILED',
            steps: steps.map((step, i) => ({
              stepId: step.stepId,
              status: mode === 'llm' || i === 0 ? 'COMPLETED' : 'SKIPPED',
            })),
            result: {
              summary: '报告专属结论',
              criteria: [
                {
                  criterionId: 'c',
                  verdict: 'FAILED',
                  summary: '报告专属实际观察',
                  evidenceRefs: [],
                },
              ],
            },
          },
        })),
      },
    ],
  } as unknown as RequestResultV2;
  const task = renderToStaticMarkup(createElement(RequestTaskCases, { value }));
  assert.match(task, /验证目标/);
  assert.match(task, /显示预期标题/);
  assert.match(task, /步骤完成 1 \/ 3/);
  for (const description of ['准备登录', '检查页面', '恢复数据'])
    assert.ok(task.includes(description));
  assert.match(task, /split-jev\?request=split-request/);
  assert.match(task, /查看执行详情/);
  assert.match(task, /执行已结束，可查看执行过程与已保留的证据/);
  assert.doesNotMatch(task, /观看实时视频/);
  assert.doesNotMatch(task, /报告专属|逐项验收|查看 DOM|split-llm/);
  const report = renderToStaticMarkup(
    createElement(RequestCases, { api: new ApiClient('fixture'), value }),
  );
  assert.match(report, /逐项验收/);
  assert.match(report, /报告专属结论/);
  assert.match(report, /报告专属实际观察/);
  assert.doesNotMatch(report, /准备登录|恢复数据|步骤完成|观看实时视频/);
  const selectedArm = value.cases[0]!.arms[1]!;
  for (const status of ['RUNNING', 'QUEUED'] as const) {
    selectedArm.result.status = status;
    const active = renderToStaticMarkup(
      createElement(RequestTaskCases, { value }),
    );
    assert.match(active, /split-jev\?request=split-request/);
    if (status === 'RUNNING') {
      assert.match(active, /button button-primary/);
      assert.match(active, /观看实时视频/);
      assert.match(active, /实时观看浏览器画面/);
      assert.match(active, /需要人工处理时可进入处理页/);
    } else {
      assert.match(active, /任务启动后，可实时观看浏览器画面/);
      assert.match(active, /查看执行详情/);
      assert.doesNotMatch(active, /观看实时视频/);
    }
  }
  value.cases[0]!.arms = [];
  const missing = renderToStaticMarkup(
    createElement(RequestTaskCases, { value }),
  );
  assert.match(missing, /暂无执行记录/);
  assert.match(missing, /显示预期标题/);
  assert.match(missing, /步骤完成 0 \/ 3/);
  assert.doesNotMatch(missing, /request-execution-entry/);
});

// 范围：两个路由互相提供次要跳转且不再呈现双标签；不触发 HTTP 或页面导航。
test('任务与报告使用互相跳转入口替代页内标签', () => {
  const api = new ApiClient('fixture');
  for (const reports of [false, true]) {
    const html = renderToStaticMarkup(
      createElement(RequestDetailPage, { api, id: 'split-request', reports }),
    );
    assert.doesNotMatch(html, /总览与验证目标|request-detail-tabs|请求内容/);
    assert.match(html, reports ? /查看任务详情/ : /查看验证报告/);
    assert.match(
      html,
      reports
        ? /href="#\/requests\/split-request"/
        : /href="#\/request-reports\/split-request"/,
    );
  }
});

// 范围：请求页兼容旧 API 的 MODEL_ERROR 分类；只静态渲染，不改写历史报告或模拟部署。
test('请求页的 MODEL_BLOCKED 与任务详情统一显示执行受阻', () => {
  for (const category of ['MODEL_ERROR', 'EXECUTION_BLOCKED']) {
    const value = {
      requestId: 'blocked-request',
      cases: [
        {
          caseId: 'blocked-case',
          title: '受阻夹具',
          reportStatus: 'INCONCLUSIVE',
          executionOrigin: 'reused',
          criteria: [],
          arms: [
            {
              taskId: 'blocked-task',
              executionMode: 'jev',
              createdAt: '2026-10-19T00:00:00Z',
              result: {
                status: 'COMPLETED',
                reportStatus: 'INCONCLUSIVE',
                executionOutcome: { category, reasonCode: 'MODEL_BLOCKED' },
              },
            },
          ],
        },
      ],
    } as unknown as RequestResultV2;
    const html = renderToStaticMarkup(
      createElement(RequestCases, { api: new ApiClient('fixture'), value }),
    );
    assert.match(html, /执行受阻/);
    assert.doesNotMatch(html, /模型服务异常/);
  }
});

// 范围：草稿归一化后重试保留身份，未知字段不被忽略；不发送浏览器请求。
test('数组粘贴转成稳定请求草稿，对象重读不生成新身份', () => {
  const request = parseVerificationRequest(JSON.stringify([CASE]));
  assert.match(request.requestId, /^request-/);
  assert.match(request.cases[0]!.caseId, /^case-/);
  assert.deepEqual(parseVerificationRequest(JSON.stringify(request)), request);
  assert.throws(
    () => parseVerificationRequest(JSON.stringify({ ...request, extra: true })),
    /不能包含未知字段/,
  );
});
// 范围：真实 ApiClient 序列化与响应跳转，HTTP 响应由夹具提供，不证明服务端执行完成。
test('请求封装完整发送并跳到请求详情', async (context) => {
  const request = parseVerificationRequest(JSON.stringify([CASE]));
  context.mock.method(
    globalThis,
    'fetch',
    async (path: unknown, init: RequestInit) => {
      assert.equal(path, '/v2/cases');
      assert.deepEqual(JSON.parse(String(init.body)), request);
      return Response.json({ requestId: request.requestId });
    },
  );
  assert.equal(
    await submitVerificationRequest(
      new ApiClient('fixture'),
      request,
      new AbortController().signal,
    ),
    `/requests/${request.requestId}`,
  );
});
// 范围：历史双跑只展示默认组，成功时省略执行摘要并默认折叠验收明细；静态夹具不证明浏览器交互或真实验收成功。
test('case 直接展开，只展示选定执行的通过数和状态', () => {
  const criterion = {
    criterionId: 'c',
    stepId: 's',
    description: '检查',
    expectedResult: '显示',
  };
  const reading = (verdict: string) => ({
    criterionId: 'c',
    verdict,
    summary: '夹具依据',
    evidenceRefs: ['artifact'],
  });
  const arm = (mode: string) => ({
    taskId: `task-${mode}`,
    executionMode: mode,
    createdAt: '2026-10-19T00:00:00Z',
    archivedAt: '2026-10-19T01:00:00Z',
    result: {
      status: 'COMPLETED',
      reportStatus: mode === 'jev' ? 'PASSED' : 'FAILED',
      steps: [],
      cleanup: null,
      result: {
        outcome: mode === 'jev' ? 'PASSED' : 'FAILED',
        summary: mode === 'jev' ? '当前记录' : '另一组记录',
        criteria: [reading(mode === 'jev' ? 'PASSED' : 'FAILED')],
        evidence: [
          {
            id: 'artifact',
            kind: 'DOM',
            sha256: 'a'.repeat(64),
            url: 'http://localhost/evidence',
          },
        ],
      },
    },
  });
  const value = {
    requestId: 'r',
    cases: [
      {
        caseId: 'a',
        title: '验证目标',
        executionOrigin: 'reused',
        arms: [arm('llm'), arm('jev')],
        criteria: [criterion],
        steps: [],
      },
    ],
  } as unknown as RequestResultV2;
  const member = value.cases[0]!;
  assert.equal(displayedCaseArm(member)?.taskId, 'task-jev');
  assert.deepEqual(caseVerificationProgress(member), { passed: 1, total: 1 });
  const preview = renderToStaticMarkup(
    createElement(RequestCasePreview, { value, reports: true }),
  );
  assert.match(preview, /1 \/ 1/);
  assert.match(preview, /执行完成/);
  assert.match(preview, /#\/request-reports\/r/);
  assert.doesNotMatch(preview, /<details|展开关联|LLM|JEV|执行次数|报告已交付/);
  const details = renderToStaticMarkup(
    createElement(RequestCases, { api: new ApiClient('fixture'), value }),
  );
  assert.match(details, /<details class="request-criterion"><summary/);
  assert.match(details, /夹具依据/);
  assert.match(details, /disabled=""[^>]*>证据已清理/);
  assert.match(details, /task-jev\?request=r/);
  assert.doesNotMatch(
    details,
    /<details[^>]* open|当前记录|复用已有执行|执行创建于|另一组记录|task-llm|LLM|JEV|无法判定/,
  );
});

// 范围：分母包含缺失项，单组兼容、执行中步骤记录及重复结果；不检查后端生成报告的真实性。
test('通过数不会合并其他模式或因缺报告缩小分母', () => {
  const member = {
    caseId: 'progress-case',
    title: '进度夹具',
    criteria: Array.from({ length: 21 }, (_, i) => ({ criterionId: `c${i}` })),
    arms: [
      {
        executionMode: 'jev',
        taskId: 'primary',
        result: {
          status: 'RUNNING',
          result: null,
          steps: [
            {
              criteria: Array.from({ length: 20 }, (_, i) => ({
                criterionId: `c${i}`,
                verdict: 'PASSED',
              })),
            },
          ],
        },
      },
      {
        executionMode: 'llm',
        taskId: 'other',
        result: {
          status: 'COMPLETED',
          result: { criteria: [{ criterionId: 'c20', verdict: 'PASSED' }] },
        },
      },
    ],
  } as unknown as RequestResultV2['cases'][number];
  assert.deepEqual(caseVerificationProgress(member), { passed: 20, total: 21 });
  const html = renderToStaticMarkup(
    createElement(RequestCasePreview, {
      value: { requestId: 'r', cases: [member] },
    }),
  );
  assert.match(html, /20 \/ 21/);
  assert.match(html, /执行中/);
  member.arms.shift();
  assert.equal(displayedCaseArm(member)?.taskId, 'other');
  assert.deepEqual(caseVerificationProgress(member), { passed: 1, total: 21 });
  member.arms[0]!.result.result!.criteria.push(
    member.arms[0]!.result.result!.criteria[0]!,
  );
  assert.deepEqual(caseVerificationProgress(member), { passed: 0, total: 21 });
  member.arms = [];
  assert.deepEqual(caseVerificationProgress(member), { passed: 0, total: 21 });
});
