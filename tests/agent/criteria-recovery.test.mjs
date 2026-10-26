import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileStepBudget,
  validateControlRequest,
} from '../../contracts/dist/index.js';
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
    criteria: decision.progress.criteria.slice(0, 1),
  };
}

// 范围：重复暂存可纠正为补证或明确受阻，持续重送有界停止；不模拟真实模型遵从率或业务结果。
test('重复登记保留已有结论并给出可恢复的收尾路径', async (t) => {
  for (const mode of ['recover', 'repeat'])
    await t.test(mode, async () => {
      let calls = 0;
      const client = new FakeControl();
      const report = await run(execution(), client, (context) => {
        if (context.task.stepId !== 'step-1') return finish(context);
        calls++;
        if (calls >= 3)
          assert.match(
            context.feedback.map((item) => item.message ?? item.code).join(' '),
            /CRITERIA_ALREADY_RECORDED/,
          );
        if (mode === 'recover' && calls === 3)
          return {
            type: 'verification.block',
            summary: '已尝试填写但未出现错误提示，不允许提交',
          };
        return {
          type: 'verification.record',
          summary: '第一项缺少提示证据',
          criteria: [
            {
              ...finish(context).progress.criteria[0],
              verdict: 'INCONCLUSIVE',
            },
          ],
        };
      });
      assert.equal(calls, mode === 'recover' ? 3 : 4);
      assert.equal(report.steps[0].status, 'BLOCKED');
      assert.equal(
        report.steps[0].reasonCode,
        mode === 'recover' ? 'MODEL_BLOCKED' : 'NO_PROGRESS',
      );
      assert.equal(report.criteria[0].verdict, 'INCONCLUSIVE');
      assert.equal(report.steps[1].status, 'COMPLETED');
    });
});

// 范围：停滞后仅一次只读整理，合法结论持久化但不冒充整步完成；模型和浏览器均为夹具。
test('停滞终止前保存独立验收，保持阻塞原因并继续后续步骤', async () => {
  const client = new FakeControl();
  let finalCalls = 0,
    actionsAtReview;
  const report = await run(execution(), client, (context, _turn, body) => {
    if (context.task.stepId !== 'step-1')
      return {
        ...finish(context),
        evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
      };
    if (context.state.settlement) {
      finalCalls++;
      actionsAtReview = client.calls.filter(
        (c) => c.operation.type === 'browser.act',
      ).length;
      assert.deepEqual(body.tools.map((t) => t.function.name).sort(), [
        'verification_block',
        'verification_record',
      ]);
      return record(context);
    }
    return { type: 'browser.act', action: 'scroll', value: 'down' };
  });
  assert.equal(finalCalls, 1);
  assert.equal(
    client.calls.filter((c) => c.operation.type === 'browser.act').length,
    actionsAtReview,
  );
  assert.deepEqual(
    report.criteria.map((c) => c.verdict),
    ['PASSED', 'SKIPPED', 'PASSED'],
  );
  assert.equal(report.steps[0].reasonCode, 'NO_PROGRESS');
  assert.equal(report.steps[0].status, 'BLOCKED');
  assert.deepEqual(
    report.steps.slice(1).map((s) => s.status),
    ['COMPLETED', 'COMPLETED'],
  );
});

// 范围：忽略只读工具、伪造证据和模型额度耗尽均不能延长执行或编造通过；不验证真实模型纠错能力。
test('停滞收尾拒绝动作与伪造引用，且不突破模型预算', async (t) => {
  for (const mode of ['action', 'invalidRef', 'noBudget'])
    await t.test(mode, async () => {
      const g = execution(),
        client = new FakeControl();
      if (mode === 'noBudget') g.task.stepBudget.steps[0].maxModelCalls = 6;
      let finalCalls = 0,
        actionsAtReview;
      const report = await run(g, client, (context) => {
        if (context.task.stepId !== 'step-1')
          return {
            ...finish(context),
            evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
          };
        if (context.state.settlement) {
          finalCalls++;
          actionsAtReview = client.calls.filter(
            (c) => c.operation.type === 'browser.act',
          ).length;
          if (mode === 'action')
            return { type: 'browser.act', action: 'click', target: '@e2' };
          const output = record(context);
          output.criteria[0].evidenceRefs = [context.page.observationId];
          return output;
        }
        return { type: 'browser.act', action: 'scroll', value: 'down' };
      });
      assert.equal(finalCalls, 1);
      assert(!client.calls.some((c) => c.operation.action === 'click'));
      if (mode !== 'noBudget')
        assert.equal(
          client.calls.filter((c) => c.operation.type === 'browser.act').length,
          actionsAtReview,
        );
      assert.deepEqual(
        report.criteria.map((c) => c.verdict),
        ['SKIPPED', 'SKIPPED', 'PASSED'],
      );
      assert.equal(
        report.steps[0].reasonCode,
        mode === 'noBudget' ? 'EVIDENCE_INCOMPLETE' : 'NO_PROGRESS',
      );
    });
});

// 范围：真实请求 schema 限定附件身份；错误引用有明确反馈且整批不落库，修正后正常完成；不代表生产模型必定遵从。
test('误用观察编号或抄错附件 ID 后可按精确反馈纠正', async () => {
  const client = new FakeControl();
  let attempts = 0;
  const report = await run(execution(), client, (context, _turn, body) => {
    if (context.task.stepId !== 'step-1')
      return {
        ...finish(context),
        evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
      };
    const output = finish(context);
    const tool = body.tools.find(
      (t) => t.function.name === 'verification_finish',
    ).function.parameters;
    const ids =
      tool.properties.progress.properties.criteria.items.properties.evidenceRefs
        .items.enum;
    assert(ids.includes(context.page.artifactRefs[0].artifactId));
    assert(!ids.includes(context.page.observationId));
    assert.deepEqual(
      tool.properties.progress.properties.requirements.items.properties
        .evidenceRefs.items.enum,
      ids,
    );
    attempts++;
    if (attempts === 1) {
      output.progress.criteria = [];
      output.workflow = {
        assessments: [
          {
            stepId: 'step-1',
            outcome: 'complete',
            summary: '夹具文案',
            evidenceRefs: [context.page.observationId],
          },
        ],
      };
    } else if (attempts === 2) {
      assert.match(
        context.feedback.map((item) => item.message ?? item.code).join(' '),
        /progress.requirements\[step-1\].evidenceRefs/,
      );
      assert(
        context.feedback
          .map((item) => item.message ?? item.code)
          .join(' ')
          .includes(context.page.observationId),
      );
      assert.deepEqual(context.state.criteria, []);
      output.progress.criteria[0].evidenceRefs = ['typo-artifact'];
    } else {
      assert.match(
        context.feedback.map((item) => item.message ?? item.code).join(' '),
        /step-1-0.*typo-artifact/,
      );
      assert.deepEqual(context.state.criteria, []);
    }
    return output;
  });
  assert.equal(attempts, 3);
  assert.equal(report.verdict, 'PASSED', report.summary);
});

// 范围：finish 内合法部分结论在工作流完整性失败前保存，不能让未完成步骤通过；模型和浏览器均为夹具。
test('FAQ 未完成的 finish 仍先持久化独立文案结论', async () => {
  const client = new FakeControl();
  let attempted = false;
  const report = await run(execution(), client, (context) => {
    if (context.task.stepId !== 'step-1')
      return {
        ...finish(context),
        evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
      };
    if (!attempted) {
      attempted = true;
      return {
        ...record(context),
        type: 'verification.finish',
        workflow: {
          assessments: [
            {
              stepId: 'step-1',
              outcome: 'incomplete',
              summary: '文案已核对，FAQ 后两题未展开',
              evidenceRefs: [],
            },
          ],
        },
      };
    }
    assert.match(
      context.feedback.map((item) => item.message ?? item.code).join(' '),
      /WORKFLOW_INCOMPLETE/,
    );
    assert.equal(context.state.criteria[0].verdict, 'PASSED');
    assert(
      client.stepSnapshots.some(
        (steps) =>
          steps[0].status === 'RUNNING' &&
          steps[0].criteria[0]?.verdict === 'PASSED',
      ),
    );
    return { type: 'verification.block', summary: '剩余 FAQ 无法取证' };
  });
  assert.deepEqual(
    report.criteria.map((c) => c.verdict),
    ['PASSED', 'SKIPPED', 'PASSED'],
  );
  assert.equal(report.steps[0].status, 'BLOCKED');
});

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
        if (context.task.stepId !== 'step-1')
          return {
            ...finish(context),
            evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
          };
        if (first) {
          first = false;
          return record(context);
        }
        assert.equal(context.state.criteria[0].verdict, 'PASSED');
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
        assert.equal(report.steps[0].reasonCode, 'EVIDENCE_INCOMPLETE');
      if (reason === 'time')
        assert.equal(report.steps[0].reasonCode, 'STEP_TIME_BUDGET_EXCEEDED');
    });
});

// 范围：finish 可补齐剩余项，setup 的 schema/反馈明确空数组，Cookie 只在清理阶段提供；不验证真实模型遵从性。
test('完成声明合并已保存项目，setup 不接受伪造验收身份，清理工具提供确定回执', async () => {
  const client = new FakeControl();
  const command = client.command.bind(client);
  client.command = async (...args) => {
    // 与真实 API 使用同一协议校验，避免宽松夹具吞掉决策元数据。
    assert.equal(
      validateControlRequest({
        type: 'execution.command',
        commandId: args[1],
        timeoutMs: 1000,
        command: args[2],
      }),
      true,
      JSON.stringify(validateControlRequest.errors),
    );
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
      context.state.phase === 'CLEANUP',
    );
    if (context.task.stepId === 'step-1') {
      if (!context.state.criteria.length) return record(context);
      const decision = finish(context);
      decision.progress.criteria.shift();
      return decision;
    }
    if (context.state.phase === 'CLEANUP') {
      assert.equal(
        tools.find((t) => t.name === 'verification_finish').parameters
          .properties.progress.properties.criteria.maxItems,
        0,
      );
      assert(tools.some((t) => t.name === 'verification_record'));
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
        assert.match(
          context.feedback.map((item) => item.message ?? item.code).join(' '),
          /progress.criteria 必须为空/,
        );
        return {
          type: 'browser.cookies.clear',
          names: ['NEXT_LOCALE'],
          progress: {},
        };
      }
      assert.equal(
        context.history.commands.find((item) => item.cookieCleanup)
          ?.cookieCleanup.verified,
        true,
        JSON.stringify({
          history: context.history,
          feedback: context.feedback,
        }),
      );
    }
    return {
      ...finish(context),
      evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
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

// 范围：补证升级的批次原子性、证据类型和幂等性；新增附件不代表真实业务语义已验收。
test('暂存验收须有新增有效证据才能升级，确定判定保持不可改写', () => {
  for (const provisional of ['INCONCLUSIVE', 'SKIPPED']) {
    for (const verdict of ['PASSED', 'FAILED']) {
      const ledger = new CriteriaLedger(
        execution().task.acceptanceCriteria.slice(0, 2),
      );
      const evidence = new Map([
        ['old', { id: 'old', kind: 'DOM' }],
        ['new', { id: 'new', kind: 'DOM' }],
        ['image', { id: 'image', kind: 'SCREENSHOT' }],
      ]);
      const original = {
        criterionId: 'step-1-0',
        verdict: provisional,
        summary: '尚缺 FAQ 答案',
        evidenceRefs: ['old'],
      };
      ledger.record([original], evidence);
      for (const evidenceRefs of [['old'], ['invented'], ['image']]) {
        assert.throws(() =>
          ledger.record([{ ...original, verdict, evidenceRefs }], evidence),
        );
        assert.deepEqual(ledger.values(), [original]);
      }
      const upgraded = {
        ...original,
        verdict,
        summary: '新证据补齐缺口',
        evidenceRefs: ['new'],
      };
      assert.throws(() =>
        ledger.record(
          [upgraded, { ...upgraded, criterionId: 'unknown' }],
          evidence,
        ),
      );
      assert.deepEqual(ledger.values(), [original]);
      assert.equal(ledger.record([upgraded], evidence), true);
      assert.deepEqual(ledger.values()[0], {
        ...upgraded,
        evidenceRefs: ['old', 'new'],
      });
      assert.equal(ledger.record([upgraded], evidence), false);
      assert.throws(() =>
        ledger.record(
          [
            {
              ...upgraded,
              verdict: verdict === 'PASSED' ? 'FAILED' : 'PASSED',
            },
          ],
          evidence,
        ),
      );
      assert.throws(() => ledger.record([original], evidence));
    }
  }
});

// 范围：复现先暂存再取证、finish 全量重送的协议链路和快照保存；浏览器及语言判定均为夹具。
test('补齐证据后的 finish 可升级暂存项并幂等合并已通过项', async () => {
  const client = new FakeControl();
  let stage = 0;
  let initialEvidence;
  const report = await run(execution(), client, (context) => {
    if (context.task.stepId !== 'step-1')
      return {
        ...finish(context),
        evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
      };
    const decision = finish(context);
    if (stage++ === 0) {
      initialEvidence = decision.progress.criteria[1].evidenceRefs[0];
      decision.type = 'verification.record';
      decision.progress.criteria[1].verdict = 'INCONCLUSIVE';
      return decision;
    }
    if (stage === 2)
      return { type: 'browser.act', action: 'scroll', value: 'down' };
    assert.notEqual(
      decision.progress.criteria[1].evidenceRefs[0],
      initialEvidence,
    );
    return decision;
  });
  assert.equal(report.verdict, 'PASSED');
  assert.equal(report.steps[0].status, 'COMPLETED');
  assert(
    client.stepSnapshots.some(
      (steps) => steps[0].criteria[1]?.verdict === 'INCONCLUSIVE',
    ),
  );
  assert.equal(report.criteria[1].evidenceRefs.length, 2);
  assert(report.criteria[1].evidenceRefs.includes(initialEvidence));
});

// 范围：保留先前步骤结论，但当前步不可借旧证据伪装已验收；仅测试引用边界，不判断真实页面语义。
test('当前步骤逐项保存不能引用先前步骤的证据', async () => {
  const g = execution(),
    client = new FakeControl();
  let previous;
  const report = await run(g, client, (context) => {
    if (context.task.stepId === 'step-1') {
      previous = context.page.artifactRefs[0].artifactId;
      return finish(context);
    }
    if (context.task.stepId === 'step-2') {
      assert(!context.evidence.some((artifact) => artifact.id === previous));
      assert(
        !context.history.excerpts.some((observation) =>
          observation.artifactRefs.some((ref) => ref.artifactId === previous),
        ),
      );
      const decision = record(context);
      decision.criteria[0].evidenceRefs = [previous];
      return decision;
    }
    return {
      ...finish(context),
      evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
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
    for (const criterion of decision.progress.criteria)
      criterion.evidenceRefs = ids;
    return decision;
  });
  assert.equal(report.verdict, 'PASSED');
  assert(report.steps.every((step) => step.status === 'COMPLETED'));
});

// 范围：缺少清理确认回执时不能把成功传输当作清理完成，业务结论保留；不覆盖真实节点删除逻辑。
test('Cookie 清理缺少确认时单独报错，业务验收仍通过', async () => {
  const report = await run(execution(), new FakeControl(), (context) =>
    context.state.phase === 'CLEANUP'
      ? { type: 'browser.cookies.clear', names: ['NEXT_LOCALE'] }
      : finish(context),
  );
  assert.equal(report.verdict, 'PASSED');
  assert.equal(report.steps[2].reasonCode, 'COOKIE_CLEANUP_UNVERIFIED');
  assert.equal(report.steps[2].status, 'ERROR');
});
