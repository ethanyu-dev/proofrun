import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { ModelCall } from '@proofrun/contracts';
import {
  BenchmarkContext,
  ContextBar,
} from '../../apps/console/src/components/benchmark-context.tsx';

/** 使用控制台 React 渲染纯文本证据，不依赖浏览器网络或实际运行记录。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// 范围：上下文占比、未知用量和纯文本转义；不验证浏览器布局、工具执行或真实供应商 token。
test('上下文详情标注字符口径并转义页面内容，缺失正文不能冒充零上下文', () => {
  const call = {
    decisionIndex: 1,
    elapsedMs: null,
    request: JSON.stringify({
      messages: [
        { role: 'system', content: '规则' },
        {
          role: 'user',
          content: JSON.stringify({
            task: {},
            state: {},
            page: { text: '<script>alert(1)</script>' },
            history: {},
            evidence: [],
            budget: {},
            feedback: [],
          }),
        },
      ],
      tools: [],
    }),
    response: null,
  } as ModelCall;
  const html = renderToStaticMarkup(
    createElement(BenchmarkContext, { call, commands: [] }),
  );
  assert.match(html, /单位：字符/);
  assert.match(html, /系统指令/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  const absent = renderToStaticMarkup(
    createElement(ContextBar, { call: { ...call, request: null } }),
  );
  assert.match(absent, /上下文未记录/);
});

// 范围：旧归档也可拆分实际页面字段，图片不混入字符统计；不验证真实 token 或浏览器视觉布局。
test('页面细分区分缓存、网络和正文并保持互斥计数', () => {
  const context = {
    task: {},
    state: {},
    page: {
      view: 'network',
      text: '',
      targets: [],
      network: { requests: [1] },
      runtime: { cacheStorage: { entries: [] } },
      runtimeLists: [{ total: 24 }],
    },
    history: {},
    evidence: [],
    budget: {},
    feedback: [],
  };
  const call = {
    decisionIndex: 1,
    imagesOmitted: 0,
    request: JSON.stringify({
      messages: [{ role: 'user', content: JSON.stringify(context) }],
    }),
  } as ModelCall;
  const html = renderToStaticMarkup(
    createElement(BenchmarkContext, { call, commands: [] }),
  );
  assert.match(html, /页面内容细分/);
  assert.match(html, /运行时 \/ 缓存/);
  assert.match(html, /视图/);
  assert.match(html, /0.*张/s);
});

// 范围：缺口的步骤、原因和原始要求以纯文本展示；不验证浏览器布局或能力规则覆盖所有自然语言。
test('能力缺口清楚标记未执行并转义原始要求', async () => {
  const { CapabilityAssessment } =
    await import('../../apps/console/src/components/capability-assessment.tsx');
  const html = renderToStaticMarkup(
    createElement(CapabilityAssessment, {
      assessment: {
        version: 'test',
        status: 'BLOCKED',
        gaps: [
          {
            capability: 'headMetadata',
            capabilityName: '页面 head 元数据读取',
            stepId: 'step-3',
            requirement: '<script>canonical</script>',
            reason: '观察不包含 head 属性',
          },
        ],
      },
    }),
  );
  assert.match(html, /缺少验证能力，未开始验证/);
  assert.match(html, /step-3/);
  assert.match(html, /未调用模型/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

// 范围：能力阻塞在列表和详情中直接展示步骤、缺失能力与原要求；纯渲染夹具不验证真实工具覆盖。
test('未启动任务的能力原因无需展开 JSON 或折叠项', async () => {
  const { CapabilityAssessment } =
    await import('../../apps/console/src/components/capability-assessment.tsx');
  const { benchmarkOutcome } =
    await import('../../apps/console/src/components/benchmark-outcome.tsx');
  const assessment = {
    version: 'fixture',
    status: 'BLOCKED' as const,
    gaps: [
      {
        capability: 'headMetadata',
        capabilityName: '页面 head 元数据读取',
        stepId: 'step-3',
        requirement: 'canonical 与 hreflang 指向对应语言',
        reason: '工具没有交付 head 标签属性',
      },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(CapabilityAssessment, { assessment }),
  );
  assert.match(html, /无法验证的要求/);
  assert.match(html, /canonical 与 hreflang/);
  assert.doesNotMatch(html, /<details/);
  const outcome = benchmarkOutcome({
    preflight: assessment,
  } as import('@proofrun/contracts/benchmark').BenchmarkCase);
  assert.equal(outcome.label, '能力不足 · 未启动');
  assert.match(outcome.summary, /step-3.*页面 head 元数据读取/);
});

// 范围：部分执行成功与单项证据不足、请求超时分开展示；合成报告不证明网站通过或定位网络超时根因。
test('部分完成不会被展示成整个五语言任务全部验收失败', async () => {
  const { BenchmarkOutcome, benchmarkOutcome } =
    await import('../../apps/console/src/components/benchmark-outcome.tsx');
  const item = {
    verdict: '未形成业务结论',
    checks: [{ name: '完整验收', passed: false, detail: '未完成' }],
    calls: [
      {
        id: 'timeout',
        callIndex: 86,
        stepId: 'step-7',
        status: 'ERROR',
        error: 'TRANSPORT_REQUEST_TIMEOUT',
        elapsedMs: 17540,
      },
    ],
    commands: [],
    verification: {
      task: {
        acceptanceCriteria: [
          { id: 'a', stepId: 'step-7', expectedResult: '邀请码校验提示为英文' },
        ],
      },
      steps: [
        { stepId: 'step-6', status: 'COMPLETED' },
        {
          stepId: 'step-7',
          status: 'BLOCKED',
          reasonCode: 'MODEL_BLOCKED',
          budgetUsage: {
            actions: 24,
            modelCalls: 27,
            limit: { maxActions: 24, maxModelCalls: 48 },
          },
        },
      ],
      report: {
        criteria: [
          { criterionId: 'done', verdict: 'PASSED', summary: 'FAQ 为英文' },
          {
            criterionId: 'a',
            verdict: 'INCONCLUSIVE',
            summary: '点击后未观察到校验提示',
          },
        ],
      },
    },
  } as unknown as import('@proofrun/contracts/benchmark').BenchmarkCase;
  assert.equal(benchmarkOutcome(item).label, '执行未完成');
  const html = renderToStaticMarkup(createElement(BenchmarkOutcome, { item }));
  assert.match(html, /1\/2 步完成/);
  assert.match(html, /证据不足，无法判定/);
  assert.match(html, /邀请码校验提示为英文/);
  assert.match(html, /动作 24\/24/);
  assert.match(html, /TRANSPORT_REQUEST_TIMEOUT/);
  assert.doesNotMatch(html, /验收失败/);
});

// 范围：新策略可运行并显示逐步跳过；旧归档仍显示当时的整项阻塞，不代表真实模型验收。
test('新能力策略提示可重跑，历史阻塞记录保持原义', async () => {
  const { CapabilityAssessment } =
    await import('../../apps/console/src/components/capability-assessment.tsx');
  const { benchmarkOutcome } =
    await import('../../apps/console/src/components/benchmark-outcome.tsx');
  const assessment = {
    version: 'verification-tools-v2',
    executionPolicy: 'skip-steps' as const,
    status: 'BLOCKED' as const,
    gaps: [
      {
        capability: 'headMetadata',
        capabilityName: '页面 head 元数据读取',
        stepId: 'step-3',
        requirement: '检查 canonical',
        reason: '缺少 head 属性',
      },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(CapabilityAssessment, { assessment }),
  );
  assert.match(html, /该规则现已移除/);
  assert.match(html, /其余步骤继续验证/);
  assert.doesNotMatch(html, /未开始验证/);
  const item = {
    preflight: assessment,
    checks: [{ name: '完整验收', passed: false }],
    calls: [],
    verification: {
      steps: [
        { stepId: 'step-2', status: 'COMPLETED' },
        {
          stepId: 'step-3',
          status: 'SKIPPED',
          reasonCode: 'VERIFICATION_CAPABILITY_MISSING',
        },
      ],
    },
  } as unknown as import('@proofrun/contracts/benchmark').BenchmarkCase;
  assert.equal(benchmarkOutcome(item).label, '部分步骤已跳过');
  assert.match(benchmarkOutcome(item).summary, /1\/2/);
  delete item.preflight!.executionPolicy;
  assert.equal(benchmarkOutcome(item).label, '能力不足 · 未启动');
});
