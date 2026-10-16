import test from 'node:test';
import assert from 'node:assert/strict';
import { compileStepBudget } from '../../contracts/dist/index.js';
import { SettlementBudget } from '../../apps/agent/dist/execution/settlement-budget.js';
import { compactDecisionText } from '../../apps/agent/dist/model/decision-view.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { execute } from '../../apps/agent/dist/execution/runner.js';
import { config, grant, FakeControl, finish, modelServer } from './fixture.mjs';

/** 合成两个独立标准，用于验证结果保存顺序，不验证模型判断内容的准确率。 */
function execution() {
  const g = grant();
  g.task.steps = [
    {
      stepId: 'check',
      type: 'verification',
      url: g.task.target.url,
      exec_order: 1,
      description: '先核对标题再操作表单',
      policy: [],
      expected: ['标题存在', '提交成功'],
    },
  ];
  g.task.acceptanceCriteria = ['title', 'submitted'].map((id) => ({
    id,
    stepId: 'check',
    description: id,
    expectedResult: id,
    evidenceKinds: ['DOM'],
  }));
  g.task.stepBudget = compileStepBudget(g.task);
  return g;
}
/** 下一动作局部计划不额外分配步骤额度。 */
const recovery = {
  goal: '操作表单',
  scope: '',
  terms: ['提交'],
  successCondition: '出现提交结果',
  maxActions: 2,
};
async function run(client, decide, g = execution(), overrides = {}) {
  const server = await modelServer(decide);
  const settings = {
    ...config,
    modelUrl: server.url,
    executionGuidance: true,
    maxContextChars: 16000,
    ...overrides,
  };
  try {
    const report = await execute(settings, client, new ChatModel(settings), g);
    assert.deepEqual(server.errors, []);
    return report;
  } finally {
    await server.close();
  }
}

// 范围：同轮结论先持久化，随后未知副作用不重放；浏览器与控制面是夹具。
test('先保存旧证据结论，再派发下一动作；未知结果不丢已保存结论', async () => {
  const client = new FakeControl();
  client.unknown = true;
  const command = client.command.bind(client);
  client.command = async (...args) => {
    if (args[2].action === 'click')
      assert.equal(
        client.stepSnapshots.at(-1)[0].criteria[0].criterionId,
        'title',
      );
    return command(...args);
  };
  const report = await run(client, (ctx) => ({
    type: 'browser.act',
    action: 'click',
    target: '@e2',
    conclusions: finish(ctx).criteria.slice(0, 1),
    workflow: { recovery },
  }));
  assert.equal(
    report.criteria.find((c) => c.criterionId === 'title').verdict,
    'PASSED',
  );
  assert.notEqual(
    report.criteria.find((c) => c.criterionId === 'submitted').verdict,
    'PASSED',
  );
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'click').length,
    1,
  );
});

// 范围：伪造附件不得写入账本或派发同轮动作，不证明自然语言判定正确。
test('无效同轮证据阻止后续动作', async () => {
  const client = new FakeControl();
  const report = await run(client, (ctx) => ({
    type: 'browser.act',
    action: 'click',
    target: '@e2',
    conclusions: [
      { ...finish(ctx).criteria[0], evidenceRefs: ['not-an-artifact'] },
    ],
    workflow: { recovery },
  }));
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'click').length,
    0,
  );
  assert(report.criteria.every((c) => c.verdict !== 'PASSED'));
});

// 范围：模型只剩一次调用时只能整理；预算未增加，结论不代替未执行操作。
test('最后一次模型额度只读收尾，并随 block 保存独立结论', async () => {
  const client = new FakeControl();
  const g = grant();
  const report = await run(
    client,
    (ctx, _turn, body) => {
      assert.equal(ctx.verificationReview.reason, 'budget');
      assert(
        body.tools.every((t) => t.function.name.startsWith('verification_')),
      );
      return {
        type: 'verification.block',
        summary: '后续条件缺失',
        conclusions: finish(ctx).criteria,
      };
    },
    g,
    { maxTurns: 1 },
  );
  assert.equal(report.criteria[0].verdict, 'PASSED', JSON.stringify(report));
  assert.equal(
    client.calls.filter(
      (c) =>
        c.operation.type === 'browser.act' && c.operation.action !== 'navigate',
    ).length,
    0,
  );
});

// 范围：时间分配可重复计算，慢模型样本影响预留；不模拟供应商实际延迟分布。
test('预留收尾额度不增加原期限，探索请求不能吃掉预留', () => {
  const b = new SettlementBudget(300000);
  assert.equal(b.shouldSettle(90000, 20), true);
  b.observe(30000);
  assert.equal(b.requestMs(100000, false), 61500);
  assert.equal(b.shouldSettle(72000, 20), false);
  assert.equal(b.shouldSettle(65000, 20), true);
  assert.equal(b.requestMs(72000, true), 71000);
  assert.equal(b.shouldSettle(250000, 1), true);
  const short = new SettlementBudget(1000);
  assert.equal(short.reserve(), 400);
});

// 范围：完全相同正文合并来源；相邻观察的差异与原截断状态原样保留，不推断截图相同。
test('历史正文仅合并完整重复副本，保留证据来源', () => {
  const a = {
    observationId: 'old-a',
    url: 'a',
    title: '标题',
    text: '公共标题\n历史答案',
    truncated: false,
    artifactRefs: [{ artifactId: 'a' }],
  };
  const result = JSON.parse(
    compactDecisionText(
      JSON.stringify({
        executionGuidance: {},
        observation: { url: 'a', text: '公共标题\n当前正文' },
        previousObservations: [
          a,
          { ...a, observationId: 'old-b', artifactRefs: [{ artifactId: 'b' }] },
          { ...a, text: '公共标题\n另一答案' },
        ],
      }),
    ),
  );
  assert.equal(result.previousObservations.length, 2);
  assert.equal(result.previousObservations[0].text, a.text);
  assert.equal(result.previousObservations[0].truncated, false);
  assert.deepEqual(result.previousObservations[0].artifactRefs, [
    { artifactId: 'a' },
    { artifactId: 'b' },
  ]);
  assert.deepEqual(
    result.previousObservations[0].equivalentTextObservationIds,
    ['old-a', 'old-b'],
  );
  assert.equal(result.previousObservations[1].text, '公共标题\n另一答案');
});

// 范围：真实 HTTP 慢回复触发原预算内收尾，禁止再次探索；页面与判断内容仍是夹具。
test('慢文本调用后提前只读整理并保留此前结论', async () => {
  const g = grant();
  g.taskDeadlineAt = new Date(Date.now() + 2000).toISOString();
  g.task.budget.timeoutMs = 2000;
  g.task.acceptanceCriteria.unshift({
    id: 'visible',
    description: '页面标题',
    expectedResult: '页面标题存在',
    evidenceKinds: ['DOM'],
  });
  const client = new FakeControl();
  const report = await run(
    client,
    async (ctx, turn, body) => {
      if (turn === 1) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        return {
          type: 'browser.act',
          action: 'fill',
          target: '@e1',
          value: 'Alice',
          workflow: { recovery },
          conclusions: finish(ctx).criteria.slice(0, 1),
        };
      }
      assert.equal(ctx.verificationReview.reason, 'budget');
      assert.equal(ctx.recordedCriteria[0].criterionId, 'visible');
      assert(
        body.tools.every((t) => t.function.name.startsWith('verification_')),
      );
      return {
        type: 'verification.block',
        summary: '剩余额度用于保存结论，提交尚未执行',
      };
    },
    g,
  );
  assert.equal(report.criteria[0].verdict, 'PASSED');
  assert.equal(report.criteria[1].verdict, 'SKIPPED');
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'fill').length,
    1,
  );
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'click').length,
    0,
  );
});

// 范围：没有可确认项目时允许空数组，避免把正常取证误判为格式错误；不放宽非空结论校验。
test('同轮 conclusions 空数组允许继续取证', async () => {
  const client = new FakeControl();
  const report = await run(client, (ctx, turn) =>
    turn === 1
      ? {
          type: 'browser.act',
          action: 'fill',
          target: '@e1',
          value: 'Alice',
          conclusions: [],
          workflow: { recovery },
        }
      : { type: 'verification.block', summary: '夹具结束', conclusions: [] },
  );
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'fill').length,
    1,
  );
  assert(report.criteria.every((c) => c.verdict === 'SKIPPED'));
});

// 范围：合法结论不依赖下一动作或工作流元数据正确；非法动作仍不得执行。
test('下一动作格式错误仅保存独立结论，不修补或执行动作', async () => {
  const client = new FakeControl();
  const report = await run(client, (ctx, turn) =>
    turn === 1
      ? {
          type: 'browser.act',
          action: 'not-an-action',
          conclusions: finish(ctx).criteria.slice(0, 1),
        }
      : { type: 'verification.block', summary: '保留已有结论，停止无效动作' },
  );
  assert.equal(report.criteria[0].verdict, 'PASSED');
  assert.equal(report.criteria[1].verdict, 'SKIPPED');
  assert.equal(
    client.calls.filter(
      (c) =>
        c.operation.type === 'browser.act' && c.operation.action !== 'navigate',
    ).length,
    0,
  );
});

// 范围：整步声明有误不抹掉独立合法结论；不会把工作流完成状态自动补为通过。
test('finish 的错误工作流元数据不丢合法验收项', async () => {
  const client = new FakeControl();
  const report = await run(client, (ctx, turn) =>
    turn === 1
      ? {
          ...finish(ctx),
          criteria: finish(ctx).criteria.slice(0, 1),
          workflow: { unknownField: true },
        }
      : { type: 'verification.block', summary: '整步仍不完整' },
  );
  assert.equal(report.criteria[0].verdict, 'PASSED');
  assert.equal(report.criteria[1].verdict, 'SKIPPED');
  assert.notEqual(report.steps[0].status, 'COMPLETED');
});

// 范围：控制面暂时拒绝保存也不能被当作模型重试越过；不模拟真实数据库故障恢复。
test('结论持久化失败后不派发下一动作', async () => {
  const { AgentFault } = await import('../../apps/agent/dist/http.js');
  const client = new FakeControl();
  const save = client.recordSteps.bind(client);
  client.recordSteps = async (execution, steps) => {
    if (steps.some((s) => s.criteria?.length))
      throw new AgentFault('HTTP_ERROR', '夹具保存失败', 500);
    return save(execution, steps);
  };
  await run(client, (ctx) => ({
    type: 'browser.act',
    action: 'click',
    target: '@e2',
    conclusions: finish(ctx).criteria.slice(0, 1),
    workflow: { recovery },
  }));
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'click').length,
    0,
  );
});

// 范围：偶发慢请求仍影响收尾预留，但不能把下一轮也当同样慢，避免过早放弃可执行任务。
test('一次慢请求不重复放大下一轮和收尾估算', () => {
  const b = new SettlementBudget(300000);
  for (const ms of [60000, 6500, 4500, 8900, 2900]) b.observe(ms);
  assert.equal(b.shouldSettle(140000, 20), false);
  assert.equal(b.shouldSettle(80000, 20), true);
  assert.equal(b.requestMs(140000, false), 64000);
});

// 范围：明确同名字段放入 workflow 时仍走原证据校验，兼容层不放宽其他字段或动作权限。
test('workflow 内同名 conclusions 经校验后先保存再执行', async () => {
  const client = new FakeControl();
  const command = client.command.bind(client);
  client.command = async (...args) => {
    if (args[2].action === 'fill')
      assert.equal(
        client.stepSnapshots.at(-1)[0].criteria[0].criterionId,
        'title',
      );
    return command(...args);
  };
  const report = await run(client, (ctx, turn) =>
    turn === 1
      ? {
          type: 'browser.act',
          action: 'fill',
          target: '@e1',
          value: 'Alice',
          workflow: { recovery, conclusions: finish(ctx).criteria.slice(0, 1) },
        }
      : { type: 'verification.block', summary: '后续未执行' },
  );
  assert.equal(report.criteria[0].verdict, 'PASSED');
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'fill').length,
    1,
  );
});

// 范围：两处声明不能静默覆盖或合并，未知附件依旧不获信任。
test('双重 conclusions 声明拒绝派发动作', async () => {
  const client = new FakeControl();
  await run(client, (ctx) => ({
    type: 'browser.act',
    action: 'fill',
    target: '@e1',
    value: 'Alice',
    conclusions: finish(ctx).criteria.slice(0, 1),
    workflow: { recovery, conclusions: finish(ctx).criteria.slice(1) },
  }));
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'fill').length,
    0,
  );
});

/** 为协议夹具生成当前原步骤的声明；不推断真实网页的业务完成情况。 */
function assessments(ctx) {
  return ctx.workflow.steps.map((s) => ({
    stepId: s.id,
    outcome: 'complete',
    summary: '夹具验证完成声明的容器与引用校验',
    evidenceRefs: ctx.observation.artifactRefs.map((a) => a.artifactId),
  }));
}

// 范围：任意原步骤的完成数组可无损规范化；没有额外模型调用，不证明实际业务已经完成。
test('finish 裸数组规范化为 assessments 后通过原工作流校验', async () => {
  const client = new FakeControl();
  let turns = 0;
  const report = await run(client, (ctx) => {
    turns++;
    return { ...finish(ctx), workflow: assessments(ctx) };
  });
  assert.equal(turns, 1);
  assert.equal(report.steps[0].status, 'COMPLETED');
});

// 范围：补容器不能接受伪造附件、未知步骤或额外字段；已经独立保存的结论不代替步骤完成。
for (const mutation of ['evidence', 'step', 'field']) {
  test(`finish 数组规范化仍拒绝非法 ${mutation}`, async () => {
    const client = new FakeControl();
    const report = await run(client, (ctx, turn) => {
      if (turn > 1) return { type: 'verification.block', summary: '夹具停止' };
      const items = assessments(ctx);
      if (mutation === 'evidence') items[0].evidenceRefs = ['missing'];
      if (mutation === 'step') items[0].stepId = 'not-an-original-step';
      if (mutation === 'field') items[0].unexpected = true;
      return { ...finish(ctx), workflow: items };
    });
    assert.notEqual(report.steps[0].status, 'COMPLETED');
  });
}

/** 先用一个有界慢请求消耗原时间，再验证只读阶段；不依赖真实模型延迟。 */
async function runSettlement(client, decide) {
  const g = grant();
  g.task.budget.timeoutMs = 5000;
  g.taskDeadlineAt = new Date(Date.now() + 5000).toISOString();
  return run(
    client,
    async (ctx, turn, body) => {
      if (turn === 1) {
        await new Promise((resolve) => setTimeout(resolve, 1800));
        return {
          type: 'verification.record',
          summary: '夹具准备收尾',
          criteria: finish(ctx).criteria,
        };
      }
      assert.equal(ctx.verificationReview?.reason, 'budget');
      return decide(ctx, turn - 1, body);
    },
    g,
    { modelMs: 3000 },
  );
}

// 范围：同一收尾阶段复用原纠错次数，修正缺陷后完成；夹具缩短时间触发收尾，不使用真实供应商。
test('只读收尾协议纠错保留结论，且后续轮次始终没有浏览器工具', async () => {
  const client = new FakeControl();
  let turns = 0;
  const report = await runSettlement(client, (ctx, turn, body) => {
    turns = turn;
    assert.equal(ctx.verificationReview.reason, 'budget');
    assert(
      body.tools.every((t) => t.function.name.startsWith('verification_')),
    );
    if (turn === 1) return { ...finish(ctx), workflow: { unknownField: true } };
    assert.match(ctx.feedback, /只读收尾协议纠错/);
    assert.equal(ctx.recordedCriteria[0].verdict, 'PASSED');
    return {
      ...finish(ctx),
      criteria: [],
      workflow: { assessments: assessments(ctx) },
    };
  });
  assert.equal(turns, 2);
  assert.equal(report.verdict, 'PASSED', JSON.stringify(report));
  assert.equal(
    client.calls.filter(
      (c) =>
        c.operation.type === 'browser.act' && c.operation.action !== 'navigate',
    ).length,
    0,
  );
});

// 范围：反复格式错误按既有三次上限停止，不能通过纠错无限延长原执行。
test('只读收尾连续协议错误到原纠错上限即阻塞', async () => {
  const client = new FakeControl();
  let turns = 0;
  const report = await runSettlement(client, (ctx, turn) => {
    turns = turn;
    return { ...finish(ctx), workflow: { unknownField: true } };
  });
  assert.equal(turns, 3);
  assert.equal(report.executionDisposition, 'BLOCKED');
  assert.equal(report.criteria[0].verdict, 'PASSED');
});

// 范围：原模型额度耗尽时禁止新增纠错调用，合法独立结论仍保留。
test('只读收尾格式错误不能突破原模型次数', async () => {
  const client = new FakeControl();
  let turns = 0;
  const report = await run(
    client,
    (ctx) => {
      turns++;
      return { ...finish(ctx), workflow: { unknownField: true } };
    },
    grant(),
    { maxTurns: 1 },
  );
  assert.equal(turns, 1);
  assert.equal(report.executionDisposition, 'BLOCKED');
  assert.equal(report.criteria[0].verdict, 'PASSED');
});

// 范围：纠错时模型擅自提出动作仍被工具围栏拒绝，不能以修复协议为名恢复探索。
test('收尾纠错不能重新执行浏览器动作', async () => {
  const client = new FakeControl();
  await runSettlement(client, (ctx, turn) =>
    turn === 1
      ? { ...finish(ctx), workflow: { unknownField: true } }
      : { type: 'browser.act', action: 'click', target: '@e2' },
  );
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'click').length,
    0,
  );
});
