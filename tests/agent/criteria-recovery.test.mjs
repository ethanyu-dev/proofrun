import assert from 'node:assert/strict';
import test from 'node:test';
import { compileStepBudget } from '../../contracts/dist/index.js';
import { execute } from '../../apps/agent/dist/execution/runner.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { CriteriaLedger } from '../../apps/agent/dist/execution/criteria.js';
import { config, grant, FakeControl, finish, modelServer } from './fixture.mjs';

/** 多标准、后续业务与无标准清理的最小夹具；不模拟业务判定质量。 */
function execution() {
  const g = grant();
  g.task.steps = [1, 2, 3].map((i) => ({
    stepId: `step-${i}`,
    type: i === 3 ? 'setup' : 'verification',
    url: g.task.target.url,
    exec_order: i,
    description: i === 3 ? '清除 NEXT_LOCALE Cookie' : '逐项检查',
    policy: [],
    expected: i === 1 ? ['A', 'B'] : i === 2 ? ['C'] : [],
  }));
  g.task.cleanupStepIds = ['step-3'];
  g.task.acceptanceCriteria = g.task.steps.flatMap((s) =>
    s.expected.map((label, i) => ({
      id: `${s.stepId}-${i}`,
      stepId: s.stepId,
      description: label,
      expectedResult: label,
      evidenceKinds: ['DOM'],
    })),
  );
  g.task.stepBudget = compileStepBudget(g.task);
  return g;
}
/** 本地 HTTP 模型服务加执行器，使用控制面夹具，资源总会关闭。 */
async function run(g, client, decide) {
  const server = await modelServer(decide);
  const settings = { ...config, modelUrl: server.url, maxContextChars: 16000 };
  try {
    const report = await execute(settings, client, new ChatModel(settings), g);
    assert.deepEqual(server.errors, []);
    return report;
  } finally {
    await server.close();
  }
}
/** 只交当前已观察的第一项，不提前声明剩余项目完成。 */
function record(context) {
  const decision = finish(context);
  return {
    type: 'verification.record',
    summary: '第一项有证据，先保存',
    criteria: decision.criteria.slice(0, 1),
  };
}

// 范围：明确受阻、模型错误、动作/模型/时间预算耗尽均保留部分结论并继续后续步骤；浏览器和模型回复为夹具。
test('部分验收持久化后发生单步故障，结果不丢且后续业务与清理继续', async (t) => {
  for (const reason of ['blocked', 'invalid', 'actions', 'modelCalls', 'time'])
    await t.test(reason, async () => {
      const g = execution(),
        client = new FakeControl();
      if (reason === 'actions') g.task.stepBudget.steps[0].maxActions = 1;
      if (reason === 'modelCalls') g.task.stepBudget.steps[0].maxModelCalls = 1;
      if (reason === 'time') g.task.stepBudget.steps[0].timeoutMs = 120;
      let first = true;
      const report = await run(g, client, async (context) => {
        if (context.executionStep.stepId !== 'step-1')
          return {
            ...finish(context),
            evidenceRefs: context.observation.artifactRefs.map(
              (a) => a.artifactId,
            ),
          };
        if (first) {
          first = false;
          return record(context);
        }
        assert.equal(context.recordedCriteria[0].verdict, 'PASSED');
        assert(
          client.stepSnapshots.some(
            (steps) =>
              steps[0].status === 'RUNNING' && steps[0].criteria.length === 1,
          ),
        );
        if (reason === 'time')
          await new Promise((resolve) => setTimeout(resolve, 150));
        if (reason === 'invalid')
          return {
            ...finish(context),
            criteria: [
              { ...record(context).criteria[0], criterionId: 'invented' },
            ],
          };
        if (reason === 'actions')
          return {
            type: 'browser.act',
            action: 'fill',
            target: '@e1',
            value: 'new value',
          };
        return { type: 'verification.block', summary: '剩余项无法继续' };
      });
      assert.deepEqual(
        report.criteria.map((c) => c.verdict),
        ['PASSED', 'SKIPPED', 'PASSED'],
      );
      assert.deepEqual(
        report.steps.slice(1).map((s) => s.status),
        ['COMPLETED', 'COMPLETED'],
      );
      assert.notEqual(report.steps[0].status, 'COMPLETED');
      const saved = client.stepSnapshots.find(
        (steps) =>
          steps[0].status === 'RUNNING' && steps[0].criteria.length === 1,
      )[0].criteria[0];
      assert.deepEqual(report.criteria[0], saved);
      if (reason === 'actions')
        assert.equal(report.steps[0].reasonCode, 'STEP_ACTION_BUDGET_EXCEEDED');
      if (reason === 'modelCalls')
        assert.equal(report.steps[0].reasonCode, 'STEP_MODEL_BUDGET_EXCEEDED');
      if (reason === 'time')
        assert.equal(report.steps[0].reasonCode, 'STEP_TIME_BUDGET_EXCEEDED');
    });
});

// 范围：finish 可补齐剩余项，setup 的 schema/反馈明确空数组，Cookie 只在清理阶段提供；不验证真实模型遵从性。
test('完成声明合并已保存项目，setup 不接受伪造验收身份，清理工具提供确定回执', async () => {
  const client = new FakeControl();
  const command = client.command.bind(client);
  client.command = async (...args) => {
    const result = await command(...args);
    if (args[2].type === 'browser.cookies.clear')
      result.data = { cleared: true, names: args[2].names };
    return result;
  };
  let cleanup = 0;
  const report = await run(execution(), client, (context, _turn, body) => {
    const tools = body.tools.map((t) => t.function);
    assert.equal(
      tools.some((t) => t.name === 'browser_cookies_clear'),
      context.cleanup,
    );
    if (context.executionStep.stepId === 'step-1') {
      if (!context.recordedCriteria.length) return record(context);
      const decision = finish(context);
      decision.criteria.shift();
      return decision;
    }
    if (context.cleanup) {
      assert.equal(
        tools.find((t) => t.name === 'verification_finish').parameters
          .properties.criteria.maxItems,
        0,
      );
      assert(!tools.some((t) => t.name === 'verification_record'));
      if (++cleanup === 1)
        return {
          type: 'verification.finish',
          summary: '错误的 setup 身份',
          criteria: [
            {
              criterionId: 'step-3',
              verdict: 'PASSED',
              summary: '夹具',
              evidenceRefs: [],
            },
          ],
        };
      if (cleanup === 2) {
        assert.match(context.feedback, /criteria 必须是 \[\]/);
        return { type: 'browser.cookies.clear', names: ['NEXT_LOCALE'] };
      }
      assert.equal(
        context.recentOperations.at(-2).cookieCleanup.verified,
        true,
      );
    }
    return {
      ...finish(context),
      evidenceRefs: context.observation.artifactRefs.map((a) => a.artifactId),
    };
  });
  assert.equal(report.verdict, 'PASSED');
  assert.equal(report.steps[2].budgetUsage.actions, 1);
  assert.equal(
    client.calls.find((c) => c.operation.type === 'browser.cookies.clear')
      .operation.url,
    execution().task.target.url,
  );
});

// 范围：账本拒绝未知/重复身份、伪造证据、缺失类型及降级；批次失败不污染原结论，不验证证据的业务语义。
test('逐项账本批次校验原子化且已保存结论不可降级', () => {
  const ledger = new CriteriaLedger(
    execution().task.acceptanceCriteria.slice(0, 2),
  );
  const evidence = new Map([['dom', { id: 'dom', kind: 'DOM' }]]);
  const item = {
    criterionId: 'step-1-0',
    verdict: 'PASSED',
    summary: '原结论',
    evidenceRefs: ['dom'],
  };
  for (const criteria of [
    [item, { ...item, criterionId: 'fake' }],
    [item, item],
    [{ ...item, evidenceRefs: ['fake'] }],
    [{ ...item, evidenceRefs: [] }],
  ]) {
    assert.throws(() => ledger.record(criteria, evidence));
    assert.deepEqual(ledger.values(), []);
  }
  assert(ledger.record([item], evidence));
  assert.throws(() =>
    ledger.record([{ ...item, verdict: 'SKIPPED' }], evidence),
  );
  assert.equal(
    ledger.record([{ ...item, summary: '覆盖尝试' }], evidence),
    false,
  );
  assert.deepEqual(ledger.values(), [item]);
});

// 范围：保留先前步骤结论，但当前步不可借旧证据伪装已验收；仅测试引用边界，不判断真实页面语义。
test('当前步骤逐项保存不能引用先前步骤的证据', async () => {
  const g = execution(),
    client = new FakeControl();
  let previous;
  const report = await run(g, client, (context) => {
    if (context.executionStep.stepId === 'step-1') {
      previous = context.observation.artifactRefs[0].artifactId;
      return finish(context);
    }
    if (context.executionStep.stepId === 'step-2') {
      assert(!context.evidence.some((artifact) => artifact.id === previous));
      assert(
        !context.previousObservations.some((observation) =>
          observation.artifactRefs.some((ref) => ref.artifactId === previous),
        ),
      );
      const decision = record(context);
      decision.criteria[0].evidenceRefs = [previous];
      return decision;
    }
    return {
      ...finish(context),
      evidenceRefs: context.observation.artifactRefs.map((a) => a.artifactId),
    };
  });
  assert.deepEqual(
    report.criteria.map((c) => c.verdict),
    ['PASSED', 'PASSED', 'SKIPPED'],
  );
  assert.equal(report.steps[1].reasonCode, 'INVALID_MODEL_DECISION');
  assert.equal(report.steps[2].status, 'COMPLETED');
});

// 范围：步骤切换后模型仅引用平台提供的 evidence 即可完成验收；不模拟真实模型选择和业务语义。
test('提供给模型的证据列表与当前步骤提交边界一致', async () => {
  const seen = new Set();
  const report = await run(execution(), new FakeControl(), (context) => {
    const ids = context.evidence.map((artifact) => artifact.id);
    assert(ids.length > 0);
    assert(ids.every((id) => !seen.has(id)));
    ids.forEach((id) => seen.add(id));
    const decision = finish(context);
    decision.evidenceRefs = ids;
    for (const criterion of decision.criteria) criterion.evidenceRefs = ids;
    return decision;
  });
  assert.equal(report.verdict, 'PASSED');
  assert(report.steps.every((step) => step.status === 'COMPLETED'));
});

// 范围：缺少清理确认回执时不能把成功传输当作清理完成，业务结论保留；不覆盖真实节点删除逻辑。
test('Cookie 清理缺少确认时单独报错，业务验收仍通过', async () => {
  const report = await run(execution(), new FakeControl(), (context) =>
    context.cleanup
      ? { type: 'browser.cookies.clear', names: ['NEXT_LOCALE'] }
      : finish(context),
  );
  assert.equal(report.verdict, 'PASSED');
  assert.equal(report.steps[2].reasonCode, 'COOKIE_CLEANUP_UNVERIFIED');
  assert.equal(report.steps[2].status, 'ERROR');
});

// 范围：JEV 在后续清理交接同一文本模型和上下文，不请求无关候选动作；不覆盖真实供应商推理质量。
test('JEV 清理阶段直接核对恢复条件和 Cookie 回执', async () => {
  const { JevModel } = await import('../../apps/agent/dist/model/jev.js');
  const model = new JevModel(
    config,
    'fixture',
    'jev-test',
    async () => {
      throw new Error('清理不应请求 JEV 候选');
    },
    {
      decide: async (input) => {
        assert.equal(JSON.parse(input.text).cleanup, true);
        return {
          decision: { type: 'browser.cookies.clear', names: ['NEXT_LOCALE'] },
        };
      },
    },
  );
  const output = await model.decide(
    {
      text: JSON.stringify({
        task: { taskId: 'fixture', objective: '清除 NEXT_LOCALE' },
        cleanup: true,
        budgetRemaining: { actions: 10 },
        observation: {
          observationId: 'o1',
          url: 'https://fixture.test',
          title: 'fixture',
          text: 'fixture',
          targets: [],
        },
        recentOperations: [],
      }),
    },
    new AbortController().signal,
  );
  assert.equal(output.decision.type, 'browser.cookies.clear');
});
