import { verificationProgress } from '../../apps/console/src/report-presentation.ts';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Window } from 'happy-dom';
import type { TaskDetail } from '../../contracts/src/index.ts';
import { ApiClient } from '../../apps/console/src/api.ts';
import { ExecutionControl } from '../../apps/console/src/components/execution-control.tsx';
import { ReportDetails } from '../../apps/console/src/pages/report-detail.tsx';
import { TaskDetailPage } from '../../apps/console/src/pages/task-detail.tsx';

/** 使用控制台自身的 React，服务端渲染只验证数据归属，不启动网络或真实执行。 */
const require = createRequire(
  new URL('../../apps/console/package.json', import.meta.url),
);
const { createElement, act } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const api = new ApiClient('fixture-comparison-credential');

// 范围：任一组的报告详情均标识双跑模式及耗时；静态渲染不覆盖入口点击和另一组的接口加载。
test('双跑报告从任一组进入都标识对照模式', () => {
  for (const arm of ['llm', 'jev'] as const) {
    const task = fixture(arm);
    const report = renderToStaticMarkup(
      createElement(ReportDetails, { api, task }),
    );
    assert.doesNotMatch(report, /当前仅展示/);
    assert.match(report, /LLM \/ LLM \+ JEV/);
    assert.match(report, /历史对照/);
    assert.match(report, /JEV 与双跑模式已停用/);
    assert.match(report, /执行时长/);
  }
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

// 范围：报告并列呈现勾叉、独立耗时及证据归属，整体仅呈现计数；静态渲染不覆盖网络加载和浏览器布局。
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
    assert.match(table, />✓</);
    assert.match(table, />×</);
    assert.match(table, /LLM \+ JEV（历史）/);
    assert(table.indexOf('>LLM<') < table.indexOf('>LLM + JEV（历史）<'));
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

// 范围：执行页移除旧模块、完整读取分页并保留来源；HTTP 为夹具，不覆盖真实浏览器会话。
test('执行页仅显示当前运行并读完操作分页', async (context) => {
  const window = new Window({
    url: 'http://localhost/#/tasks/fixture-pair-jev?request=request-fixture',
  });
  const globals = {
    window,
    document: window.document,
    location: window.location,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const prior = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createRoot } = require('react-dom/client');
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container);
  const localApi = new ApiClient('fixture');
  const calls: string[] = [];
  context.mock.method(localApi, 'json', async (path: string) => {
    calls.push(path);
    if (path === '/v1/tasks/fixture-pair-jev') return fixture('jev');
    if (path.endsWith('/timeline'))
      return {
        commands: [
          {
            id: 'first',
            kind: 'browser.act',
            action: 'click',
            actor: 'AGENT',
            status: 'SUCCEEDED',
            error: null,
            effect: null,
            created_at: '2026-09-28T00:00:01Z',
            screenshots: [],
          },
        ],
        nextCursor: 'first',
      };
    if (path.endsWith('/timeline?after=first'))
      return {
        commands: [
          {
            id: 'second',
            kind: 'browser.act',
            action: 'scroll',
            actor: 'HUMAN',
            status: 'FAILED',
            error: 'TEST_ERROR',
            effect: null,
            created_at: '2026-09-28T00:00:02Z',
            screenshots: [],
          },
        ],
        nextCursor: null,
      };
    throw new Error(`非预期读取：${path}`);
  });
  try {
    await act(async () =>
      root.render(
        createElement(TaskDetailPage, {
          api: localApi,
          id: 'fixture-pair-jev',
        }),
      ),
    );
    assert.equal(container.querySelector('h1')?.textContent, '执行过程');
    assert.match(container.textContent!, /点击/);
    assert.match(container.textContent!, /滚动 · 人工/);
    assert.match(container.textContent!, /TEST_ERROR/);
    assert.doesNotMatch(
      container.textContent!,
      /验收报告|决策上下文|原始任务定义|执行与资源清理|同次历史运行|JEV|CRITERION/,
    );
    assert(container.querySelector('a[href="#/requests/request-fixture"]'));
    assert.deepEqual(
      calls.filter((path) => path.includes('/timeline')),
      [
        '/v1/admin/executions/execution-jev/timeline',
        '/v1/admin/executions/execution-jev/timeline?after=first',
      ],
    );
    assert(
      !calls.some((path) =>
        /comparison|model-calls|live-frame|execution-llm/.test(path),
      ),
    );
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

// 范围：模拟实时帧与任务终态切换，完成后关闭订阅并进入步骤回放；不代表真实节点视频传输验收。
test('执行完成后退出实时画面且不把最后帧冒充步骤截图', async (context) => {
  const window = new Window({
    url: 'http://localhost/#/tasks/fixture-pair-llm',
  });
  const globals = {
    window,
    document: window.document,
    location: window.location,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const prior = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { StepPlayback } =
    await import('../../apps/console/src/components/step-playback.tsx');
  const { createRoot } = require('react-dom/client');
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container);
  const localApi = new ApiClient('fixture');
  let closed = 0;
  const socket = {
    onmessage: null as null | ((event: { data: string }) => void),
    onerror: null,
    onclose: null,
    close: () => {
      closed++;
    },
  };
  context.mock.method(localApi, 'live', () => socket);
  context.mock.method(localApi, 'json', async (path: string) => {
    if (path.endsWith('/timeline')) return { commands: [], nextCursor: null };
    if (path.endsWith('/live-frame')) return { frame: null };
    throw Error(`非预期读取：${path}`);
  });
  const task = fixture('llm');
  task.state = 'RUNNING';
  task.report = null;
  task.executions[0]!.state = 'RUNNING';
  try {
    await act(async () =>
      root.render(
        createElement(StepPlayback, {
          api: localApi,
          task,
          execution: task.executions[0],
        }),
      ),
    );
    assert(container.querySelector('[aria-label="实时交互"]'));
    await act(async () =>
      socket.onmessage!({
        data: JSON.stringify({ type: 'frame', data: 'YWJj', capturedAt: 123 }),
      }),
    );
    assert(container.querySelector('img[alt="浏览器实时画面"]'));
    const completed = structuredClone(task);
    completed.state = 'COMPLETED';
    completed.executions[0]!.state = 'FINISHED';
    await act(async () =>
      root.render(
        createElement(StepPlayback, {
          api: localApi,
          task: completed,
          execution: completed.executions[0],
        }),
      ),
    );
    assert(container.querySelector('[aria-label="步骤回放"]'));
    assert.equal(container.querySelector('img'), null);
    assert.equal(closed, 1);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
