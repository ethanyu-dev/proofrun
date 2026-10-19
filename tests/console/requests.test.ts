import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { RequestResultV2 } from '@proofrun/contracts';
import { ApiClient } from '../../apps/console/src/api.ts';
import { parseVerificationRequest } from '../../apps/console/src/task-definition.ts';
import { submitVerificationRequest } from '../../apps/console/src/components/task-submit-request.ts';
import { RequestSummaryView } from '../../apps/console/src/components/request-summary.tsx';
import { RequestCases } from '../../apps/console/src/components/request-cases.tsx';

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
// 范围：部分结果、共享来源、缺报告、组名、证据清理及返回上下文的可见文本；不代替窄屏或点击验收。
test('请求组件明确显示部分结果和两组来源，归档证据不能点击', () => {
  const arm = (mode: 'llm' | 'jev') => ({
    taskId: `task-${mode}`,
    executionMode: mode,
    createdAt: '2026-10-19T00:00:00Z',
    archivedAt: '2026-10-19T01:00:00Z',
    result: {
      caseId: 'a',
      status: mode === 'llm' ? 'COMPLETED' : 'QUEUED',
      reportStatus: mode === 'llm' ? 'PASSED' : null,
      criteriaCounts: null,
      result:
        mode === 'llm'
          ? {
              outcome: 'PASSED',
              summary: '夹具依据',
              criteria: [],
              evidence: [
                {
                  id: 'artifact',
                  kind: 'DOM',
                  sha256: 'a'.repeat(64),
                  url: 'http://localhost/evidence',
                },
              ],
            }
          : null,
      steps: [],
      cleanup: null,
    },
  });
  const value = {
    requestId: 'r',
    title: '请求',
    createdAt: '2026-10-19T00:00:00Z',
    generatedAt: '2026-10-19T00:00:00Z',
    sourceRequestId: null,
    aggregationVersion: 1,
    caseCount: 1,
    finishedCaseCount: 0,
    executionStatus: 'IN_PROGRESS',
    executionCounts: {
      total: 2,
      queued: 1,
      running: 0,
      completed: 1,
      cancelled: 0,
      timedOut: 0,
      error: 0,
    },
    reportPhase: 'PARTIAL',
    reportStatus: null,
    reportCoverage: { expected: 2, available: 1, missing: 1 },
    observedFailureCount: 0,
    confirmedDisagreementCount: 0,
    uniqueCriteriaCounts: {
      total: 1,
      passed: 0,
      failed: 0,
      inconclusive: 0,
      skipped: 0,
      pending: 1,
    },
    byExecutionMode: [],
    cases: [
      {
        caseId: 'a',
        title: '验证目标',
        executionOrigin: 'reused',
        sourceCaseId: null,
        reportStatus: null,
        finished: false,
        arms: [arm('llm'), arm('jev')],
        criteria: [
          {
            criterionId: 'c',
            stepId: 's',
            description: '检查',
            expectedResult: '显示',
            status: 'PENDING',
            disagreement: false,
            coverageDifference: true,
            arms: [
              {
                taskId: 'task-llm',
                executionMode: 'llm',
                verdict: 'PASSED',
                summary: '夹具',
                evidenceRefs: ['artifact'],
              },
              {
                taskId: 'task-jev',
                executionMode: 'jev',
                verdict: null,
                summary: '',
                evidenceRefs: [],
              },
            ],
          },
        ],
      },
    ],
  } as RequestResultV2;
  const summary = renderToStaticMarkup(
    createElement(RequestSummaryView, { value }),
  );
  assert.match(summary, /部分结果/);
  assert.match(summary, /尚未汇总完成/);
  assert.match(summary, /唯一验收项 1/);
  const cases = renderToStaticMarkup(
    createElement(RequestCases, { api: new ApiClient('fixture'), value }),
  );
  for (const text of [
    '复用已有执行',
    'LLM',
    'JEV + LLM',
    '缺少报告',
    '证据已清理',
    '两组覆盖不同',
  ])
    assert.ok(cases.includes(text));
  assert.match(cases, /disabled=""[^>]*>证据已清理/);
  assert.match(cases, /task-llm\?request=r/);
});
