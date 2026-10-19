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
// 范围：历史双跑只展示默认组的进度、状态和证据；静态夹具不证明浏览器交互或真实验收成功。
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
  assert.match(details, /当前记录/);
  assert.match(details, /disabled=""[^>]*>证据已清理/);
  assert.match(details, /task-jev\?request=r/);
  assert.doesNotMatch(details, /<details|另一组记录|task-llm|LLM|JEV|无法判定/);
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
