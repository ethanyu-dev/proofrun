import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { TaskDetail } from '../../contracts/src/index.ts';
import { ApiClient } from '../../apps/console/src/api.ts';
import { ExecutionControl } from '../../apps/console/src/components/execution-control.tsx';
import { ComparisonDetails } from '../../apps/console/src/components/comparison.tsx';

/** 使用控制台自身的 React，服务端渲染只验证数据归属，不启动网络或真实执行。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const api = new ApiClient('fixture-comparison-credential');

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
