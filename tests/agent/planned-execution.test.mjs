import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PlannedModel,
  executionEvent,
} from '../../apps/agent/dist/execution/model-router.js';
import { JevSelector } from '../../apps/agent/dist/model/jev-selector.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { execute } from '../../apps/agent/dist/execution/runner.js';
import { decisionContext } from '../../apps/agent/dist/execution/context.js';
import {
  planFields,
  validatePlanInputs,
} from '../../apps/agent/dist/execution/plan-inputs.js';
import { Workflow } from '../../apps/agent/dist/execution/workflow.js';
import { OperationJournal } from '../../apps/agent/dist/execution/operation-journal.js';
import { AgentFault } from '../../apps/agent/dist/http.js';
import { config, grant, FakeControl, finish, modelServer } from './fixture.mjs';

/** 合成表单只验证执行协议与字段绑定，不代表真实登录或服务端提交验收。 */
class FormControl extends FakeControl {
  values = {};
  async command(execution, id, operation) {
    if (operation.action === 'fill')
      this.values[operation.target] = operation.value;
    const result = await super.command(execution, id, operation);
    if (operation.type === 'browser.observe') {
      result.data.text = this.submitted
        ? `已提交 ${this.values['@e1']} ${this.values['@e3']}`
        : `名称 ${this.values['@e1'] ?? ''} 城市 ${this.values['@e3'] ?? ''}`;
      result.data.targets = [
        {
          target: '@e1',
          role: 'textbox',
          name: '名称',
          value: this.values['@e1'] ?? '',
          operations: ['fill'],
        },
        {
          target: '@e3',
          role: 'textbox',
          name: '城市',
          value: this.values['@e3'] ?? '',
          operations: ['fill'],
        },
        { target: '@e2', role: 'button', name: '提交', operations: ['click'] },
      ];
    }
    return result;
  }
}
/** 有界计划只为夹具任务生成输入，不绑定真实账号或旧观察 target。 */
function plan(extra = {}) {
  return {
    goal: '填写并提交测试表单',
    scope: '',
    terms: ['表单'],
    successCondition: '观察到已提交 Alice 杭州',
    allowedActions: ['fill', 'click'],
    maxActions: 4,
    ...extra,
  };
}
/** 使用实际候选集合构造合法概率，仅验证协议，不估计模型准确率。 */
function answer(body, choose) {
  const criteria = body.questions.next.criteria;
  const id = choose(criteria);
  assert(id && id in criteria);
  return {
    answers: {
      next: {
        choice: id,
        confidence: 1,
        probabilities: Object.fromEntries(
          Object.keys(criteria).map((key) => [key, Number(key === id)]),
        ),
      },
    },
    usage: { input_tokens: 3, output_tokens: 1 },
  };
}
/** 使用公共构造器提供真实类型化快照，原始浏览器事实仍来自合成夹具。 */
function input(extra = {}) {
  const current = {
    observationId: 'page-1',
    url: 'https://fixture.test/form',
    title: '表单',
    text: '名称',
    atomic: false,
    targets: [
      { target: 'name', role: 'textbox', name: '名称', operations: ['fill'] },
    ],
    artifactRefs: [],
  };
  const workflow = new Workflow('填写名称', undefined, undefined, true);
  workflow.apply({ recovery: plan() }, new Set(), 10, new Set());
  return decisionContext({
    task: grant().task,
    executionStep: undefined,
    preconditions: [],
    workflow: workflow.view(),
    budgetRemaining: { actions: 10, modelCalls: 10, timeMs: 90_000 },
    current,
    changes: undefined,
    evidence: [],
    history: [],
    previousObservations: [],
    feedback: null,
    image: undefined,
    maxContextChars: 64_000,
    executionPolicy: {
      version: 'planned-v1',
      scope: 'step:tab:0:0',
      event: { code: 'CONTINUE' },
    },
    ...extra,
  });
}

// 范围：首轮计划与动作同交、后续字段复用、点击检查点、逐请求审计；模型和控制面均为本地夹具。
test('统一计划连续填写只需一次规划和一次结果复核', async () => {
  const client = new FormControl();
  const execution = grant();
  execution.task.executionMode = 'jev';
  execution.task.objective = '填写名称 Alice 和城市 杭州并提交表单';
  execution.task.budget.timeoutMs = 90_000;
  execution.taskDeadlineAt = new Date(Date.now() + 90_000).toISOString();
  const server = await modelServer((context, count, body) => {
    assert.equal(context.executionPolicy.version, 'planned-v1');
    assert.equal(context.workflow.recovery, undefined);
    if (count === 1) {
      assert.equal(context.executionPolicy.event.code, 'PLAN_REQUIRED');
      const act = body.tools.find((t) => t.function.name === 'browser_act')
        .function.parameters;
      assert(act.required.includes('plan'));
      assert.equal(act.properties.workflow.properties.recovery, undefined);
      return {
        type: 'browser.act',
        action: 'fill',
        target: '@e1',
        value: 'Alice',
        plan: plan({
          inputs: [
            {
              key: context.inputFields.find((f) => f.name === '城市').key,
              value: '杭州',
            },
          ],
          checkpoints: ['after-click'],
        }),
      };
    }
    assert.equal(count, 2);
    assert.equal(context.executionPolicy.event.code, 'CHECKPOINT');
    assert.match(context.observation.text, /已提交 Alice 杭州/);
    return finish(context);
  });
  try {
    const settings = {
      ...config,
      executionPolicy: 'planned-v1',
      maxTurns: 12,
      maxContextChars: 64_000,
      modelUrl: server.url,
    };
    let selections = 0;
    const selector = new JevSelector(
      settings,
      'fixture',
      'jev-test',
      async (_u, _k, _m, body) => {
        selections++;
        assert.equal(body.state.workflow.recovery, undefined);
        assert.equal(body.state.plan.goal, plan().goal);
        return answer(
          body,
          (criteria) =>
            Object.entries(criteria).find(([, c]) =>
              selections === 1
                ? c.operation === 'TYPE_TEXT' && c.field.name === '城市'
                : c.operation === 'CLICK',
            )[0],
        );
      },
    );
    const report = await execute(
      settings,
      client,
      new PlannedModel(new ChatModel(settings), selector),
      execution,
    );
    assert.equal(report.verdict, 'PASSED', JSON.stringify(report));
    assert.equal(selections, 2);
    assert.equal(server.requests.length, 2);
    assert.deepEqual(server.errors, []);
    assert.equal(report.executionDetails.modelCalls, 4);
    assert.deepEqual(
      client.modelCalls
        .filter((c) => c.body.phase === 'start')
        .map((c) => c.body.record.purpose),
      ['DECISION', 'JEV_SELECTION', 'JEV_SELECTION', 'DECISION'],
    );
    assert.deepEqual(
      client.calls
        .filter((c) => c.operation.action === 'fill')
        .map((c) => c.operation.value),
      ['Alice', '杭州'],
    );
  } finally {
    await server.close();
  }
});

// 范围：缺失值进入统一复核并保留完整任务和计划，不再发独立 FIELD_VALUE 请求；不验证真实模型选值质量。
test('未知字段值转统一复核并保留选择用量', async () => {
  let reviews = 0;
  const selector = new JevSelector(
    config,
    'fixture',
    'jev-test',
    async (_u, _k, _m, body) =>
      answer(body, (c) =>
        Object.keys(c).find((k) => c[k].operation === 'TYPE_TEXT'),
      ),
  );
  const model = new PlannedModel(
    {
      decide: async (request) => {
        reviews++;
        assert.equal(
          request.context.executionPolicy.event.code,
          'DECISION_GAP',
        );
        assert.equal(request.context.plan.goal, plan().goal);
        assert.equal(request.context.budgetRemaining.modelCalls, 9);
        assert(request.context.budgetRemaining.timeMs <= 90_000);
        return {
          decision: {
            type: 'verification.block',
            summary: '缺少填写事实',
            reasonCode: 'OTHER',
          },
          promptTokens: 5,
          completionTokens: 2,
        };
      },
    },
    selector,
  );
  const out = await model.decide(input(), new AbortController().signal);
  assert.equal(reviews, 1);
  assert.equal(out.reviewed, true);
  assert.equal(out.promptTokens, 8);
  assert.equal(out.completionTokens, 3);
});

// 范围：语义绑定随重新编号保留，页面/名称/歧义/密码变化失效；不证明任意网站具有足够唯一的字段语义。
test('计划输入只绑定当前唯一非秘密字段', () => {
  const page = input().observation;
  const key = planFields(page)[0].key;
  assert.equal(
    planFields({
      ...page,
      targets: [{ ...page.targets[0], target: 'new', value: 'Alice' }],
    })[0].key,
    key,
  );
  for (const changed of [
    { ...page, url: 'https://fixture.test/other' },
    { ...page, targets: [{ ...page.targets[0], name: '其他名称' }] },
    {
      ...page,
      targets: [page.targets[0], { ...page.targets[0], target: 'duplicate' }],
    },
    { ...page, targets: [{ ...page.targets[0], name: '密码' }] },
  ])
    assert.throws(
      () =>
        validatePlanInputs(
          plan({ inputs: [{ key, value: 'Alice' }] }),
          changed,
        ),
      { code: 'INVALID_MODEL_DECISION' },
    );
});

// 范围：批量采集依赖显式计划、正文覆盖和数量；只模拟采集事实，不将其判断为业务通过。
test('采集检查点统一考虑数量和截断，普通填写不自动复核', () => {
  const context = input().context;
  context.plan.collectReadings = true;
  context.interactionProgress = {
    items: [{ status: 'observed', text: '答案', truncated: false }],
    omittedItems: 0,
  };
  context.recentOperations = [
    {
      commandId: 'fill',
      operation: 'browser.act',
      action: 'fill',
      operationStatus: 'SUCCEEDED',
      effect: 'COMPLETED',
    },
  ];
  assert.equal(executionEvent(context).code, 'CONTINUE');
  context.plan.checkpoints = ['after-fill'];
  assert.equal(executionEvent(context).code, 'CHECKPOINT');
  context.executionPolicy.reviewedCommandId = 'fill';
  assert.equal(executionEvent(context).code, 'CONTINUE');
  context.interactionProgress.items[0].truncated = true;
  assert.equal(executionEvent(context).code, 'CHECKPOINT');
  context.interactionProgress.items = Array.from({ length: 4 }, () => ({
    status: 'observed',
    truncated: false,
  }));
  assert.equal(executionEvent(context).code, 'CHECKPOINT');
});

// 范围：模型错误可以复核，预算和审计错误不可吞掉；不连接真实供应商。
test('候选故障回退不吞预算或审计失败', async () => {
  for (const code of [
    'INVALID_MODEL_DECISION',
    'STEP_MODEL_BUDGET_EXCEEDED',
    'MODEL_TRACE_UNAVAILABLE',
  ]) {
    let reviews = 0;
    const model = new PlannedModel(
      {
        decide: async () => {
          reviews++;
          return {
            decision: { type: 'verification.block', summary: '停止' },
            promptTokens: 0,
            completionTokens: 0,
          };
        },
      },
      {
        select: async () => {
          throw new AgentFault(code, '夹具错误');
        },
      },
    );
    const pending = model.decide(input(), new AbortController().signal);
    if (code === 'INVALID_MODEL_DECISION') {
      await pending;
      assert.equal(reviews, 1);
    } else {
      await assert.rejects(pending, { code });
      assert.equal(reviews, 0);
    }
  }
});

// 范围：少量调用额度直接交文本层，真实发请求仍由 recordRequest 扣减；不测真实模型响应时延。
test('仅剩两次调用时保留复核和收尾机会', async () => {
  const request = input({
    budgetRemaining: { actions: 4, modelCalls: 2, timeMs: 90_000 },
  });
  assert.equal(request.context.executionPolicy.event.code, 'CHECKPOINT');
  const model = new PlannedModel(
    {
      decide: async () => ({
        decision: { type: 'verification.block', summary: '保留已有结果' },
        promptTokens: 0,
        completionTokens: 0,
      }),
    },
    { select: async () => assert.fail('不得消耗额外候选调用') },
  );
  assert.equal(
    (await model.decide(request, new AbortController().signal)).reviewed,
    true,
  );
});

// 范围：计划换名、换输入和重新编号不能恢复同状态额度；不把自然语言成功条件作为可执行断言。
test('计划元数据不能绕过已消耗的动作额度', () => {
  const workflow = new Workflow('填写名称', undefined, undefined, true);
  workflow.observeState(input().observation);
  workflow.apply(
    { recovery: plan({ maxActions: 1 }) },
    new Set(),
    10,
    new Set(),
  );
  workflow.acted();
  workflow.apply(
    {
      recovery: plan({
        goal: '换一个名称',
        inputs: [{ key: 'fixture', value: '另一个值' }],
      }),
    },
    new Set(),
    10,
    new Set(),
  );
  assert.equal(workflow.view().recovery.remaining, 0);
  assert.throws(
    () => workflow.assertAction({ type: 'browser.act', action: 'click' }),
    { code: 'WORKFLOW_RECOVERY_EXHAUSTED' },
  );
});

// 范围：近期窗口和关键回执来自同一有界集合，切步保留背景但清除本步关键事实；不覆盖控制面完整审计。
test('操作记录派生两个视图且长期关键回执不保存值', () => {
  const journal = new OperationJournal();
  journal.record({
    commandId: 'fill',
    operation: 'browser.act',
    action: 'fill',
    value: 'fixture',
    operationStatus: 'SUCCEEDED',
    effect: 'COMPLETED',
  });
  for (let i = 0; i < 12; i++)
    journal.record({
      commandId: `observe-${i}`,
      operation: 'browser.observe',
      operationStatus: 'SUCCEEDED',
      effect: 'COMPLETED',
    });
  assert.equal(journal.recent().length, 8);
  assert.equal(journal.critical().items[0].commandId, 'fill');
  assert.equal(journal.critical().items[0].value, undefined);
  journal.beginScope();
  assert.equal(journal.critical().items.length, 0);
  assert.equal(journal.recent().length, 8);
});

// 范围：仅身份代次变化也使运行中回复失效并重新规划；模拟控制面版本，不验证真实 Cookie 和人工页面。
test('模型运行期间身份变化拒绝旧动作并清除旧计划', async () => {
  const client = new FormControl();
  let authRevision = 0;
  client.view = async (execution) => ({
    ...(await FakeControl.prototype.view.call(client, execution)),
    authRevision,
    controlRevision: 0,
    controlMode: 'AUTO',
  });
  const execution = grant();
  execution.task.budget.timeoutMs = 90_000;
  execution.taskDeadlineAt = new Date(Date.now() + 90_000).toISOString();
  const server = await modelServer((context, count) => {
    if (count === 1) {
      authRevision++;
      return {
        type: 'browser.act',
        action: 'fill',
        target: '@e1',
        value: '过期值',
        plan: plan(),
      };
    }
    assert.equal(context.plan, null);
    assert.equal(context.executionPolicy.event.code, 'ENVIRONMENT_CHANGED');
    return {
      type: 'verification.block',
      summary: '重新核实账号后停止',
      reasonCode: 'OTHER',
    };
  });
  try {
    const settings = {
      ...config,
      modelUrl: server.url,
      executionPolicy: 'planned-v1',
      maxContextChars: 64_000,
    };
    await execute(
      settings,
      client,
      new PlannedModel(new ChatModel(settings)),
      execution,
    );
    assert.equal(server.requests.length, 2);
    assert.deepEqual(server.errors, []);
    assert.equal(
      client.calls.filter((c) => c.operation.action === 'fill').length,
      0,
    );
  } finally {
    await server.close();
  }
});

// 范围：复核说明加入后仍遵守总字符上限，固定约束不丢失；合成大正文不验证语义摘录质量。
test('复核视图使用同一裁剪预算且不修改执行器原始观察', async () => {
  const request = input({ maxContextChars: 5000 });
  const original = structuredClone(request.observation);
  request.context.previousObservations = Array.from({ length: 8 }, (_, i) => ({
    observationId: String(i),
    url: 'https://fixture.test/old',
    title: '历史',
    text: '历史正文'.repeat(300),
    artifactRefs: [],
    truncated: false,
  }));
  request.context.executionPolicy.event = {
    code: 'EXECUTION_EXCEPTION',
    detail: '需要复核'.repeat(20),
  };
  const model = new PlannedModel({
    decide: async (next) => {
      assert(next.text.length <= 5000);
      assert.equal(next.context.task.objective, request.context.task.objective);
      assert.equal(
        next.context.plan.successCondition,
        request.context.plan.successCondition,
      );
      assert(next.context.truncated);
      return {
        decision: { type: 'verification.block', summary: '保留缺口' },
        promptTokens: 0,
        completionTokens: 0,
      };
    },
  });
  await model.decide(request, new AbortController().signal);
  assert.deepEqual(request.observation, original);
  assert.equal(request.context.previousObservations.length, 8);
});

// 范围：候选缺值后的实际 LLM 请求同样扣预算，预算拒绝时不得发 HTTP；不覆盖真实服务计费。
test('统一回退请求不能绕过原模型预算', async () => {
  const server = await modelServer(() => assert.fail('预算已拒绝该请求'));
  try {
    const settings = { ...config, modelUrl: server.url };
    const selector = new JevSelector(
      settings,
      'fixture',
      'jev-test',
      async (_u, _k, _m, body) =>
        answer(body, (c) =>
          Object.keys(c).find((k) => c[k].operation === 'TYPE_TEXT'),
        ),
    );
    const request = input();
    let calls = 0;
    request.recordRequest = () => {
      if (++calls > 1)
        throw new AgentFault('STEP_MODEL_BUDGET_EXCEEDED', '夹具额度用完');
    };
    await assert.rejects(
      new PlannedModel(new ChatModel(settings), selector).decide(
        request,
        new AbortController().signal,
      ),
      { code: 'STEP_MODEL_BUDGET_EXCEEDED' },
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

// 范围：字段元数据非法时整批拒绝，不能留下新计划；只验证协议类型和边界。
test('非法计划输入不会部分保存', () => {
  for (const inputs of [
    null,
    'invalid',
    [null],
    [{ key: 'k', value: 3 }],
    [{ key: 'k', value: 'v', unexpected: true }],
  ]) {
    const workflow = new Workflow('填写名称', undefined, undefined, true);
    assert.throws(
      () => workflow.apply({ recovery: plan({ inputs }) }, new Set(), 6),
      { code: 'INVALID_MODEL_DECISION' },
    );
    assert.equal(workflow.view().recovery, null);
  }
});

// 范围：四个面板连续采集后一次复核、引文校验及来源保留；页面为夹具，不代表真实 FAQ 质量验收。
test('批量面板采集跳过已取得正文的目标并统一登记', async () => {
  const execution = grant();
  execution.task.executionMode = 'jev';
  execution.task.objective = '读取四个 FAQ 面板并核对全部答案';
  execution.task.budget.timeoutMs = 90_000;
  execution.task.budget.maxActions = 10;
  execution.taskDeadlineAt = new Date(Date.now() + 90_000).toISOString();
  const client = new FakeControl();
  let opened = null;
  const command = client.command.bind(client);
  client.command = async (...args) => {
    if (args[2].action === 'click') opened = args[2].target;
    const result = await command(...args);
    if (args[2].type === 'browser.observe') {
      result.data.text = opened ? `正文 ${opened}` : '四个问题';
      result.data.targets = Array.from({ length: 4 }, (_, i) => ({
        target: `q${i + 1}`,
        comparisonKey: `question-${i + 1}`,
        role: 'button',
        name: `问题${i + 1}`,
        operations: ['click'],
        disclosure: {
          relation: 'aria-controls',
          expanded: opened === `q${i + 1}`,
          visible: opened === `q${i + 1}`,
          text: opened === `q${i + 1}` ? `答案${i + 1}` : '',
          truncated: false,
        },
      }));
    }
    return result;
  };
  const server = await modelServer((context, count) => {
    if (count === 1)
      return {
        type: 'browser.act',
        action: 'click',
        target: 'q1',
        plan: plan({
          goal: '读取四个面板',
          successCondition: '四个答案均已取得',
          allowedActions: ['click'],
          collectReadings: true,
          maxActions: 6,
        }),
      };
    assert.equal(count, 2);
    assert.equal(
      context.interactionProgress.items.filter((i) => i.status === 'observed')
        .length,
      4,
    );
    const result = finish(context);
    result.criteria[0].evidenceRefs = [
      ...new Set(
        context.interactionProgress.items.flatMap((i) => i.evidenceRefs),
      ),
    ];
    result.workflow = {
      readings: context.interactionProgress.items.map((i) => ({
        itemId: i.id,
        quote: i.text,
      })),
    };
    return result;
  });
  try {
    const settings = {
      ...config,
      modelUrl: server.url,
      executionPolicy: 'planned-v1',
      maxTurns: 12,
      maxContextChars: 64_000,
    };
    const chosen = [];
    const selector = new JevSelector(
      settings,
      'fixture',
      'jev-test',
      async (_u, _k, _m, body) =>
        answer(body, (criteria) => {
          const entry = Object.entries(criteria).find(
            ([, c]) => c.operation === 'CLICK',
          );
          chosen.push(entry[1].field.name);
          return entry[0];
        }),
    );
    const report = await execute(
      settings,
      client,
      new PlannedModel(new ChatModel(settings), selector),
      execution,
    );
    assert.equal(report.verdict, 'PASSED', JSON.stringify(report));
    assert.deepEqual(chosen, ['问题2', '问题3', '问题4']);
    assert.equal(server.requests.length, 2);
    assert.deepEqual(server.errors, []);
    assert.equal(report.executionDetails.modelCalls, 5);
  } finally {
    await server.close();
  }
});
