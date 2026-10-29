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
const api = new ApiClient('fixture-report-credential');

// 范围：当前报告显示执行方式与耗时；静态渲染不覆盖真实浏览器执行。
test('报告标识单 LLM 执行', () => {
  const report = renderToStaticMarkup(
    createElement(ReportDetails, { api, task: fixture('first') }),
  );
  assert.match(report, /纯 LLM/);
  assert.match(report, /执行时长/);
});

/** 两个独立任务刻意采用不同报告、节点及清理状态，使跨任务混用不能被相同夹具掩盖。 */
function fixture(arm: 'first' | 'second'): TaskDetail {
  const id = `fixture-run-${arm}`;
  return {
    id,
    state: 'COMPLETED',
    reportStatus: arm === 'first' ? 'PASSED' : 'INCONCLUSIVE',
    criteriaCounts: {
      total: 1,
      passed: arm === 'first' ? 1 : 0,
      failed: 0,
      inconclusive: arm === 'first' ? 0 : 1,
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
      objective: '报告夹具',
      target: { url: 'https://example.test' },
      environment: { id: 'fixture', nodePool: 'fixture' },
      budget: { maxActions: 10, timeoutMs: 1200000 },
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
        session_state: arm === 'first' ? 'CLOSED' : 'CLOSING',
        closure_verified: arm === 'first',
        action_count: arm === 'first' ? 3 : 7,
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
      verdict: arm === 'first' ? 'PASSED' : 'INCONCLUSIVE',
      summary: `REPORT-${arm}`,
      criteria: [
        {
          criterionId: 'result',
          verdict: arm === 'first' ? 'PASSED' : 'INCONCLUSIVE',
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
  const task = fixture('first');
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

// 范围：交接阶段与人工阶段的提示以及两个独立任务原因隔离；不验证异步链接获取或真实浏览器操作。
test('顶部待办区分交接与可处理状态且不再展示操作表', () => {
  const first = fixture('first');
  const second = fixture('second');
  for (const task of [first, second]) {
    task.state = 'RUNNING';
    task.executions[0].state = 'RUNNING';
    task.executions[0].control_reason = `请登录 ${task.id}`;
  }
  first.executions[0].control_mode = 'REQUESTED';
  second.executions[0].control_mode = 'HUMAN';
  const waiting = renderControl(first);
  const human = renderControl(second);
  assert.ok(waiting.includes('等待执行交接'));
  assert.ok(!waiting.includes('正在获取处理入口'));
  assert.ok(human.includes('需要人工处理'));
  assert.ok(human.includes('正在获取处理入口'));
  assert.ok(waiting.includes('请登录 fixture-run-first'));
  assert.ok(!waiting.includes('请登录 fixture-run-second'));
  assert.ok(human.includes('请登录 fixture-run-second'));
  assert.ok(!human.includes('请登录 fixture-run-first'));
  assert.ok(!human.includes('<table'));
});

// 范围：单任务清理、未知和重复结果不增加通过数；不验证模型判断真实性。
test('验收统计排除清理和不明确的记录', () => {
  const task = fixture('first');
  const base = task.definition.acceptanceCriteria[0]!;
  task.definition.acceptanceCriteria = [
    base,
    { ...base, id: 'missing' },
    { ...base, id: 'cleanup', stepId: 'cleanup' },
  ];
  task.definition.cleanupStepIds = ['cleanup'];
  task.report!.criteria.push(
    { ...task.report!.criteria[0]!, criterionId: 'cleanup' },
    { ...task.report!.criteria[0]!, criterionId: 'unknown' },
  );
  assert.deepEqual(verificationProgress(task), { passed: 1, total: 2 });
  task.report!.criteria.push({ ...task.report!.criteria[0]! });
  assert.deepEqual(verificationProgress(task), { passed: 0, total: 2 });
});
// 范围：报告证据来自当前任务，两个独立任务不能互相串用；不覆盖证据文件加载。
test('报告只展示当前运行的证据', () => {
  for (const id of ['first', 'second'] as const) {
    const html = renderToStaticMarkup(
      createElement(ReportDetails, { api, task: fixture(id) }),
    );
    assert.match(html, new RegExp(`artifact-${id}`));
    assert.doesNotMatch(
      html,
      new RegExp(`artifact-${id === 'first' ? 'second' : 'first'}`),
    );
  }
});

// 范围：未生成报告时仍按定义计总数，并只计已登记通过；不从执行状态或清理推断业务结果。
test('运行中和零业务项目保留准确分母', () => {
  const task = fixture('first');
  task.report = null;
  assert.deepEqual(verificationProgress(task), { passed: 0, total: 1 });
  task.definition.acceptanceCriteria = [];
  assert.deepEqual(verificationProgress(task), { passed: 0, total: 0 });
});

// 范围：环境故障保留原始原因，不能据此冒充业务通过；不验证真实故障触发。
test('报告保留当前运行的环境阻塞原因', () => {
  const task = fixture('second');
  task.executionOutcome = {
    category: 'ENVIRONMENT_BLOCKED',
    reasonCode: 'ENVIRONMENT_NOT_READY',
    terminationCode: 'SESSION_ENDED',
    detail: '缺少指定测试账号',
    waitingSince: null,
    waitDeadline: null,
  };
  const html = renderToStaticMarkup(
    createElement(ReportDetails, { api, task }),
  );
  assert.match(html, /环境阻塞/);
  assert.match(html, /缺少指定测试账号/);
  assert.match(html, />0 \/ 1</);
});

// 范围：执行页移除旧模块、完整读取分页并保留来源；HTTP 为夹具，不覆盖真实浏览器会话。
test('执行页仅显示当前运行并读完操作分页', async (context) => {
  const window = new Window({
    url: 'http://localhost/#/tasks/fixture-run-second?request=request-fixture',
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
    if (path === '/v1/tasks/fixture-run-second') return fixture('second');
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
          id: 'fixture-run-second',
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
        '/v1/admin/executions/execution-second/timeline',
        '/v1/admin/executions/execution-second/timeline?after=first',
      ],
    );
    assert(
      !calls.some((path) =>
        /comparison|model-calls|live-frame|execution-first/.test(path),
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
    url: 'http://localhost/#/tasks/fixture-run-first',
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
  const task = fixture('first');
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
