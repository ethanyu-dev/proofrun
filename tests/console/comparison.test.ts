import { verificationProgress } from '../../apps/console/src/report-presentation.ts';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { TaskDetail } from '../../contracts/src/index.ts';
import { ApiClient } from '../../apps/console/src/api.ts';
import { ExecutionControl } from '../../apps/console/src/components/execution-control.tsx';
import { ComparisonDetails } from '../../apps/console/src/components/comparison.tsx';
import { TaskComparisonLink } from '../../apps/console/src/components/task-comparison-link.tsx';
import { ReportDetails } from '../../apps/console/src/pages/report-detail.tsx';

/** 使用控制台自身的 React，服务端渲染只验证数据归属，不启动网络或真实执行。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const api = new ApiClient('fixture-comparison-credential');

// 范围：入口使用服务端关联，任一组可进入两组详情；不凭名称推测双跑，不覆盖点击和接口轮询。
test('双跑入口从任一组进入对照详情，单组和旧响应不伪造入口', () => {
  for (const arm of ['llm', 'jev'] as const) {
    const task = fixture(arm);
    const html = renderToStaticMarkup(
      createElement(TaskComparisonLink, {
        id: task.id,
        comparison: task.definition.comparison,
      }),
    );
    assert.match(html, /查看双跑对比/);
    assert.ok(html.includes(`href="#/tasks/${task.id}"`));
    const report = renderToStaticMarkup(
      createElement(ReportDetails, { api, task }),
    );
    assert.doesNotMatch(report, /当前仅展示/);
    assert.match(report, /LLM \/ LLM \+ JEV/);
    assert.match(report, /执行时长/);
  }
  for (const comparison of [null, undefined])
    assert.equal(
      renderToStaticMarkup(
        createElement(TaskComparisonLink, {
          id: 'comparison-case-v2-name-only-jev',
          comparison,
        }),
      ),
      '',
    );
});

/** 两组刻意采用不同报告、节点及清理状态，使跨组混用不能被相同夹具掩盖。 */
function fixture(arm: 'llm' | 'jev'): TaskDetail {
  const id = `fixture-pair-${arm}`;
  return {
    id,
    state: 'COMPLETED',
    reportStatus: arm === 'llm' ? 'PASSED' : 'INCONCLUSIVE',
    criteriaCounts: {
      total: 1,
      passed: arm === 'llm' ? 1 : 0,
      failed: 0,
      inconclusive: arm === 'llm' ? 0 : 1,
      skipped: 0,
    },
    created_at: '2026-09-28T00:00:00Z',
    deadline_at: '2026-09-28T00:20:00Z',
    finished_at: '2026-09-28T00:01:00Z',
    archived_at: null,
    error: null,
    definition: {
      protocolVersion: '0.1',
      taskId: id,
      objective: '对照夹具',
      target: { url: 'https://example.test' },
      environment: { id: 'fixture', nodePool: 'fixture' },
      budget: { maxActions: 10, timeoutMs: 1200000 },
      comparison: { id: 'fixture-pair', arm, sourceTaskId: 'fixture-source' },
      acceptanceCriteria: [
        {
          id: 'result',
          description: '检查结果',
          expectedResult: '各自证据',
          evidenceKinds: ['DOM'],
        },
      ],
    },
    executions: [
      {
        id: `execution-${arm}`,
        worker_id: `worker-${arm}`,
        state: 'FINISHED',
        lease_expires_at: '2026-09-28T00:01:00Z',
        session_id: `session-${arm}`,
        node_id: `node-${arm}`,
        session_state: arm === 'llm' ? 'CLOSED' : 'CLOSING',
        closure_verified: arm === 'llm',
        action_count: arm === 'llm' ? 3 : 7,
        control_mode: 'AUTO',
        control_revision: 0,
        control_reason: null,
      },
    ],
    report: {
      protocolVersion: '0.1',
      taskId: id,
      lifecycle: 'COMPLETED',
      executionDisposition: 'EXECUTED',
      verdict: arm === 'llm' ? 'PASSED' : 'INCONCLUSIVE',
      summary: `REPORT-${arm}`,
      criteria: [
        {
          criterionId: 'result',
          verdict: arm === 'llm' ? 'PASSED' : 'INCONCLUSIVE',
          summary: `CRITERION-${arm}`,
          evidenceRefs: [`artifact-${arm}`],
        },
      ],
      artifacts: [
        {
          id: `artifact-${arm}`,
          kind: 'DOM',
          sha256: '0'.repeat(64),
          uri: `/v1/artifacts/artifact-${arm}`,
        },
      ],
    },
  };
}

/** 只切分独立组容器，内部验收条目的 article 不改变组归属。 */
function renderArms(tasks: TaskDetail[]): string[] {
  const html = renderToStaticMarkup(
    createElement(ComparisonDetails, { api, arms: tasks }),
  );
  return html.split(/<article class="comparison-detail-arm[^\"]*"/).slice(1);
}

// 范围：两组五个模块及报告、证据、关闭状态不串组；不覆盖浏览器异步请求或真实模型运行。
test('所有详情模块按组隔离报告、证据与资源清理状态', () => {
  const cards = renderArms([fixture('llm'), fixture('jev')]);
  assert.equal(cards.length, 10);
  assert.ok(!cards.join('').includes('人工介入与操作记录'));
  for (const [index, card] of cards.entries()) {
    const arm = index % 2 === 0 ? 'llm' : 'jev';
    const other = arm === 'llm' ? 'jev' : 'llm';
    assert.ok(card.includes(`data-task-id="fixture-pair-${arm}"`));
    assert.ok(!card.includes(`REPORT-${other}`));
    assert.ok(!card.includes(`CRITERION-${other}`));
    assert.ok(!card.includes(`artifact-${other}`));
    assert.ok(!card.includes(`node-${other}`));
  }
  assert.ok(cards[0].includes('已确认关闭'));
  assert.ok(cards[1].includes('尚未确认关闭'));
  assert.ok(cards[4].includes('CRITERION-llm'));
  assert.ok(cards[5].includes('CRITERION-jev'));
  assert.ok(cards[6].includes('artifact-llm'));
  assert.ok(cards[7].includes('artifact-jev'));
});

// 范围：单组排队、无会话及无报告时保留独立空态；不模拟请求错误、轮询或人工取消。
test('尚未开始的一组不会沿用另一组上下文或报告', () => {
  const waiting = fixture('jev');
  waiting.state = 'QUEUED';
  waiting.finished_at = null;
  waiting.executions = [];
  waiting.report = null;
  const cards = renderArms([fixture('llm'), waiting]);
  assert.ok(cards[3].includes('尚未分配执行'));
  assert.ok(cards[5].includes('尚未生成报告'));
  assert.ok(cards[7].includes('尚未生成报告'));
  assert.ok(!cards[5].includes('REPORT-llm'));
});

/** 只渲染待办入口；服务端渲染不触发链接接口或真实人工交接。 */
function renderControl(task: TaskDetail): string {
  return renderToStaticMarkup(
    createElement(ExecutionControl, {
      api,
      task,
      execution: task.executions[0],
    }),
  );
}

// 范围：自动执行及已结束任务不显示待办，即使数据库保留 HUMAN；不验证后台控制状态迁移。
test('人工入口只出现在仍待处理的执行中', () => {
  const task = fixture('llm');
  task.state = 'RUNNING';
  task.executions[0].state = 'RUNNING';
  assert.equal(renderControl(task), '');
  task.executions[0].control_mode = 'HUMAN';
  for (const state of [
    'COMPLETED',
    'CANCELLED',
    'TIMED_OUT',
    'FAILED',
  ] as const) {
    task.state = state;
    assert.equal(renderControl(task), '');
  }
  task.state = 'RUNNING';
  task.executions[0].state = 'FINISHED';
  assert.equal(renderControl(task), '');
});

// 范围：交接阶段与人工阶段的提示以及两组原因隔离；不验证异步链接获取或真实浏览器操作。
test('顶部待办区分交接与可处理状态且不再展示操作表', () => {
  const llm = fixture('llm');
  const jev = fixture('jev');
  for (const task of [llm, jev]) {
    task.state = 'RUNNING';
    task.executions[0].state = 'RUNNING';
    task.executions[0].control_reason = `请登录 ${task.id}`;
  }
  llm.executions[0].control_mode = 'REQUESTED';
  jev.executions[0].control_mode = 'HUMAN';
  const waiting = renderControl(llm);
  const human = renderControl(jev);
  assert.ok(waiting.includes('等待执行交接'));
  assert.ok(!waiting.includes('正在获取处理入口'));
  assert.ok(human.includes('需要人工处理'));
  assert.ok(human.includes('正在获取处理入口'));
  assert.ok(waiting.includes('请登录 fixture-pair-llm'));
  assert.ok(!waiting.includes('请登录 fixture-pair-jev'));
  assert.ok(human.includes('请登录 fixture-pair-jev'));
  assert.ok(!human.includes('请登录 fixture-pair-llm'));
  assert.ok(!human.includes('<table'));
});

// 范围：两组结果按验收身份取任一通过并去重，清理、未知和重复记录不增加通过数；不验证模型判断真实性。
test('双跑通过数按项目合并，不以两组通过数相加或要求同时通过', () => {
  const llm = fixture('llm');
  const jev = fixture('jev');
  const base = llm.definition.acceptanceCriteria[0]!;
  for (const task of [llm, jev]) {
    task.definition.acceptanceCriteria = [
      base,
      { ...base, id: 'second' },
      { ...base, id: 'missing' },
      { ...base, id: 'cleanup', stepId: 'cleanup' },
    ];
    task.definition.cleanupStepIds = ['cleanup'];
    task.report!.criteria.push({
      ...task.report!.criteria[0]!,
      criterionId: 'cleanup',
      verdict: 'PASSED',
    });
  }
  jev.report!.criteria[0]!.verdict = 'FAILED';
  jev.report!.criteria.push({
    ...jev.report!.criteria[0]!,
    criterionId: 'second',
    verdict: 'PASSED',
  });
  assert.deepEqual(verificationProgress([llm, jev]), { passed: 2, total: 3 });
  assert.deepEqual(verificationProgress([jev, llm]), { passed: 2, total: 3 });
  llm.report!.criteria.push({ ...llm.report!.criteria[0]! });
  assert.deepEqual(verificationProgress([llm, jev]), { passed: 1, total: 3 });
  jev.report!.criteria.push({
    ...jev.report!.criteria[0]!,
    criterionId: 'unknown',
    verdict: 'PASSED',
  });
  assert.deepEqual(verificationProgress([llm, jev]), { passed: 1, total: 3 });
});

// 范围：报告并列呈现对错、独立耗时及证据归属，整体仅呈现计数；静态渲染不覆盖网络加载和浏览器布局。
test('报告从任一组进入都呈现相同合并计数和固定模式顺序', () => {
  const llm = fixture('llm');
  const jev = fixture('jev');
  jev.report!.criteria[0]!.verdict = 'FAILED';
  for (const [task, elapsedMs] of [
    [llm, 12300],
    [jev, 45600],
  ] as const) {
    task.report!.executionDetails = {
      reasonCode: null,
      model: 'fixture',
      modelCalls: 1,
      actions: 1,
      elapsedMs,
      commandIds: [],
      promptTokens: 0,
      completionTokens: 0,
    };
  }
  for (const task of [llm, jev]) {
    const html = renderToStaticMarkup(
      createElement(ReportDetails, { api, task, arms: [jev, llm] }),
    );
    const overview = html.slice(0, html.indexOf('aria-label="验证汇总"'));
    assert.match(overview, />1 \/ 1</);
    assert.doesNotMatch(overview, /无法判定|未通过|当前仅展示/);
    const table = html.slice(html.indexOf('<table'), html.indexOf('</table>'));
    assert.match(table, />对</);
    assert.match(table, />错</);
    assert(table.indexOf('>LLM<') < table.indexOf('>LLM + JEV<'));
    assert.match(html, /12.3 秒/);
    assert.match(html, /45.6 秒/);
    assert(html.indexOf('验证汇总') < html.indexOf('各模式验证记录'));
    assert.match(html, /artifact-llm/);
    assert.match(html, /artifact-jev/);
  }
});

// 范围：未生成报告时仍按定义计总数，并只计已登记通过；不从执行状态或清理推断业务结果。
test('运行中和零业务项目保留准确分母', () => {
  const task = fixture('llm');
  task.report = null;
  assert.deepEqual(verificationProgress([task]), { passed: 0, total: 1 });
  task.definition.acceptanceCriteria = [];
  assert.deepEqual(verificationProgress([task]), { passed: 0, total: 0 });
});

// 范围：合并后的报告保留各模式执行异常，异常不覆盖任一模式已通过的计数；不验证真实故障触发。
test('双跑报告保留各组执行原因且不改变合并通过数', () => {
  const llm = fixture('llm');
  const jev = fixture('jev');
  jev.executionOutcome = {
    category: 'ENVIRONMENT_BLOCKED',
    reasonCode: 'ENVIRONMENT_NOT_READY',
    terminationCode: 'SESSION_ENDED',
    detail: 'JEV 组缺少指定测试账号',
    waitingSince: null,
    waitDeadline: null,
  };
  const html = renderToStaticMarkup(
    createElement(ReportDetails, { api, task: jev, arms: [llm, jev] }),
  );
  assert.match(html, /环境阻塞/);
  assert.match(html, /JEV 组缺少指定测试账号/);
  assert.match(html, /旧节点未记录具体触发原因/);
  assert.match(html, />1 \/ 1</);
});
