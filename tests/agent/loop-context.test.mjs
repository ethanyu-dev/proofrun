import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  decisionContext,
  rememberObservation,
} from '../../packages/execution-core/dist/execution/context.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { Workflow } from '../../packages/execution-core/dist/execution/workflow.js';
import { observation } from '../../packages/execution-core/dist/evidence/observation.js';
import { config, grant, FakeControl, modelServer } from './fixture.mjs';

/** 复用 Contracts 已固定的 AJV 校验出站 schema，不新增测试专用依赖。 */
const Ajv = createRequire(
  new URL('../../contracts/package.json', import.meta.url),
)('ajv');

/** 最小真实观察协议夹具；不连接浏览器，也不证明业务验收通过。 */
async function input() {
  const execution = grant();
  const client = new FakeControl();
  const current = observation(
    await client.command(execution, 'read-current', {
      type: 'browser.observe',
    }),
  );
  const args = {
    task: execution.task,
    current,
    workflow: new Workflow(execution.task.objective).view(),
    preconditions: [],
    evidence: client.artifacts,
    history: [],
    previousObservations: [],
    budgetRemaining: { actions: 5, modelCalls: 5, timeMs: 30000 },
    feedback: null,
    maxContextChars: 12000,
  };
  return { args, current, client };
}

// 范围：检查真实 ChatModel HTTP 出站工具的 schema 与必填语义；回复为脚本，不证明供应商兼容性或模型质量。
test('各执行阶段出站工具均为合法 JSON Schema', async (suite) => {
  for (const phase of ['PREPARING', 'CHECKING', 'VERIFYING', 'CLEANUP']) {
    // 范围：当前阶段全部开放工具均可通过元 schema 校验及编译；不调用真实模型服务。
    await suite.test(phase, async () => {
      const { args } = await input();
      const server = await modelServer(() => ({
        type: 'verification.block',
        summary: '仅校验出站工具协议',
      }));
      try {
        await new ChatModel({ ...config, modelUrl: server.url }).decide(
          decisionContext({
            ...args,
            setupPhase: ['PREPARING', 'CHECKING'].includes(phase)
              ? phase
              : undefined,
            cleanup: phase === 'CLEANUP',
          }),
          new AbortController().signal,
        );
        assert.deepEqual(server.errors, []);
        assert.equal(server.requests.length, 1);
        const request = server.requests[0];
        assert.equal(
          JSON.parse(request.messages[1].content).state.phase,
          phase,
        );
        const ajv = new Ajv({ strict: false, allErrors: true });
        const tools = new Map();
        for (const { function: tool } of request.tools) {
          assert.equal(
            ajv.validateSchema(tool.parameters),
            true,
            `${phase}/${tool.name}: ${ajv.errorsText()}`,
          );
          tools.set(tool.name, ajv.compile(tool.parameters));
        }
        const preparing = ['PREPARING', 'CHECKING'].includes(phase);
        assert.equal(tools.has('verification_record'), !preparing);
        const validate = tools.get(
          preparing ? 'verification_finish' : 'verification_record',
        );
        const payload = { summary: '夹具声明', progress: { criteria: [] } };
        assert.equal(validate(payload), true, ajv.errorsText(validate.errors));
        // 修复重复声明时仍须保留阶段必填约束，不能靠删除必填项让 schema 通过。
        assert.equal(validate({ summary: payload.summary }), false);
        assert(
          validate.errors.some(
            (error) =>
              error.keyword === 'required' &&
              error.params.missingProperty === 'progress',
          ),
        );
      } finally {
        await server.close();
      }
    });
  }
});

// 范围：唯一模型投影、历史目标剔除、命令去重与时间顺序；不验证浏览器内部输入去重。
test('context 只有七个模块，历史回执合并有序且不泄露调度与身份材料', async () => {
  const { args, current } = await input();
  args.task.environment.auth = {
    nodeId: 'private-node',
    stateId: 'private-state',
    restore: true,
  };
  const previous = [];
  rememberObservation(previous, {
    ...current,
    text: '旧正文 [target=obsolete] ref=e99',
  });
  const operation = (id, effect = 'COMPLETED') => ({
    commandId: id,
    operation: 'browser.act',
    action: 'click',
    operationStatus: 'SUCCEEDED',
    effect,
  });
  const result = decisionContext({
    ...args,
    previousObservations: previous,
    actionMemory: { items: [operation('old'), operation('last')], omitted: 2 },
    history: [operation('between', 'NOT_STARTED'), operation('last')],
  });
  assert.deepEqual(Object.keys(result.context), [
    'task',
    'state',
    'page',
    'history',
    'evidence',
    'budget',
    'feedback',
  ]);
  assert.deepEqual(
    result.context.history.commands.map((x) => x.commandId),
    ['old', 'between', 'last'],
  );
  assert.equal(result.context.history.omittedCommands, 2);
  assert(!result.text.includes('obsolete'));
  assert(!result.text.includes('private-state'));
  assert(!result.text.includes('comparisonKey'));
  assert.deepEqual(
    JSON.parse(result.text),
    JSON.parse(JSON.stringify(result.context)),
  );
});
// 范围：真实 HTTP 请求一次决策只有一次调用、工具读取相同证据集合及新 progress 解析；模型返回为脚本。
test('单轮 LLM 直接保存 progress 并提出动作，无 plan 或 JEV 子调用', async () => {
  const { args } = await input();
  let requests = 0;
  const server = await modelServer((context, count, body) => {
    requests++;
    assert.equal(count, 1);
    assert.equal(body.parallel_tool_calls, false);
    assert(
      !body.tools.some((t) => t.function.name === 'verification_environment'),
    );
    for (const tool of body.tools) {
      assert(!('workflow' in tool.function.parameters.properties));
      assert(!('plan' in tool.function.parameters.properties));
      assert(!('criteria' in tool.function.parameters.properties));
      // JSON Schema 不接受空 enum；没有候选时应关闭对应分支。
      assert(!JSON.stringify(tool).includes('"enum":[]'));
    }
    const id = context.evidence[0].id;
    return {
      raw: {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  type: 'function',
                  function: {
                    name: 'browser_act',
                    arguments: JSON.stringify({
                      action: 'fill',
                      target: context.page.targets[0].target,
                      value: 'Alice',
                      progress: {
                        requirements: [
                          {
                            id: context.task.requirements[0].id,
                            status: 'incomplete',
                            summary: '仍需提交',
                            evidenceRefs: [id],
                          },
                        ],
                      },
                    }),
                  },
                },
              ],
            },
          },
        ],
      },
    };
  });
  try {
    const out = await new ChatModel({ ...config, modelUrl: server.url }).decide(
      decisionContext(args),
      new AbortController().signal,
    );
    assert.equal(out.decision.type, 'browser.act');
    assert.equal(out.decision.progress.requirements[0].status, 'incomplete');
    assert.equal(requests, 1);
    assert.deepEqual(server.errors, []);
  } finally {
    await server.close();
  }
});
// 范围：旧入口和未知进度字段明确拒绝，不默默转换为新的计划；不测真实模型纠错率。
test('旧 plan、workflow 和裸数组 progress 均被拒绝', async () => {
  const { args } = await input();
  for (const extra of [
    { plan: {} },
    { workflow: {} },
    { progress: [] },
    { progress: { mystery: [] } },
  ]) {
    const server = await modelServer(() => ({
      raw: {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  type: 'function',
                  function: {
                    name: 'verification_block',
                    arguments: JSON.stringify({ summary: '受阻', ...extra }),
                  },
                },
              ],
            },
          },
        ],
      },
    }));
    try {
      await assert.rejects(
        new ChatModel({ ...config, modelUrl: server.url }).decide(
          decisionContext(args),
          new AbortController().signal,
        ),
        { code: 'INVALID_MODEL_DECISION' },
      );
    } finally {
      await server.close();
    }
  }
});
// 范围：上下文上限不修改权威输入，固定要求过大时明确失败；不将字符预算等同供应商 token。
test('固定约束超限明确拒绝，不裁剪成一个可通过的较小任务', async () => {
  const { args } = await input();
  args.task.objective = '不可删除的原始要求'.repeat(2000);
  const original = structuredClone(args);
  assert.throws(() => decisionContext({ ...args, maxContextChars: 2000 }), {
    code: 'CONTEXT_BUDGET_EXCEEDED',
  });
  assert.deepEqual(args, original);
});

// 范围：空保存不能充当进度或续费；脚本响应不代表供应商一定遵守工具协议。
test('verification_record 拒绝缺失或空 progress', async () => {
  const { args } = await input();
  for (const extra of [
    {},
    { progress: {} },
    { progress: { criteria: [], requirements: [], readings: [] } },
  ]) {
    const server = await modelServer(() => ({
      raw: {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  type: 'function',
                  function: {
                    name: 'verification_record',
                    arguments: JSON.stringify({
                      summary: '没有新进度',
                      ...extra,
                    }),
                  },
                },
              ],
            },
          },
        ],
      },
    }));
    try {
      await assert.rejects(
        new ChatModel({ ...config, modelUrl: server.url }).decide(
          decisionContext(args),
          new AbortController().signal,
        ),
        { code: 'INVALID_MODEL_DECISION' },
      );
    } finally {
      await server.close();
    }
  }
});

// 范围：只有完全相同的历史正文合并引用，差异正文独立保留；不推断截图相同。
test('唯一上下文合并重复历史正文并保留来源', async () => {
  const { args, client } = await input();
  const first = {
    observationId: 'old-a',
    url: 'a',
    title: '标题',
    text: '历史答案',
    truncated: false,
    artifactRefs: [{ artifactId: client.artifacts[0].id, kind: 'DOM' }],
  };
  const secondId = 'other-artifact';
  args.evidence = [...args.evidence, { ...client.artifacts[0], id: secondId }];
  args.previousObservations = [
    first,
    {
      ...first,
      observationId: 'old-b',
      artifactRefs: [{ artifactId: secondId, kind: 'DOM' }],
    },
    { ...first, text: '另一个答案' },
  ];
  const excerpts = decisionContext(args).context.history.excerpts;
  assert.equal(excerpts.length, 2);
  assert.deepEqual(
    excerpts[0].artifactRefs.map((ref) => ref.artifactId),
    [client.artifacts[0].id, secondId],
  );
  assert.equal(excerpts[1].text, '另一个答案');
});

// 范围：同地址、同正文但不同 lang 的观察不能合并，历史保留独立快照；不证明真实模型一定正确判断语言。
test('语言切换的历史文档声明与正文一起保留，不被当前状态覆盖', async () => {
  const { args, current } = await input();
  const history = [];
  const documents = [
    { url: current.url, lang: 'zh-CN', frameId: 'main', isMainFrame: true },
  ];
  rememberObservation(history, { ...current, documents });
  documents[0].lang = 'en';
  rememberObservation(history, { ...current, documents });
  const result = decisionContext({
    ...args,
    current: { ...current, documents: [{ ...documents[0], lang: 'fr' }] },
    previousObservations: history,
  }).context;
  assert.equal(result.page.documents[0].lang, 'fr');
  assert.deepEqual(
    result.history.excerpts.map((item) => item.documents[0].lang),
    ['zh-CN', 'en'],
  );
  assert.deepEqual(
    result.history.excerpts[0].artifactRefs,
    current.artifactRefs.map(({ artifactId, kind }) => ({
      artifactId,
      kind,
      sha256: undefined,
    })),
  );
  assert.equal(
    result.history.excerpts[0].text,
    result.history.excerpts[1].text,
  );
  result.history.excerpts[0].documents[0].lang = 'fr';
  assert.equal(history[0].documents[0].lang, 'zh-CN');
});

// 范围：大列表只裁剪模型副本并保留不完整标志；不把摘要当成完整缓存或网络验收。
test('运行时证据超过上下文预算时明确截断，原始证据保持完整', async () => {
  const { args, current } = await input();
  current.runtime = {
    version: 1,
    status: 'observed',
    cacheStorage: {
      entries: Array.from({ length: 200 }, (_, i) => ({
        url: `https://fixture.test/${i}/${'x'.repeat(300)}`,
      })),
      truncated: false,
    },
  };
  const result = decisionContext({ ...args, maxContextChars: 8000 });
  assert(result.text.length <= 8000);
  assert.equal(result.context.page.runtime.cacheStorage.truncated, true);
  assert.equal(result.context.page.runtime.cacheStorage.complete, false);
  assert.equal(current.runtime.cacheStorage.entries.length, 200);
  assert.equal(current.runtime.cacheStorage.truncated, false);
});

// 范围：键盘目标收紧不能误伤鼠标点击的非聚焦控件；校验真实出站 schema，不连接业务浏览器。
test('不可聚焦目标仍可点击，但不能用于定向按键', async () => {
  const { args, current } = await input();
  current.targets[0].focusable = true;
  current.targets[1].focusable = false;
  current.viewport = { targetedPress: true };
  const server = await modelServer(() => ({
    type: 'browser.act',
    action: 'click',
    target: '@e2',
  }));
  const settings = { ...config, modelUrl: server.url };
  try {
    await new ChatModel(settings).decide(
      decisionContext(args),
      new AbortController().signal,
    );
    const schema = server.requests[0].tools.find(
      (t) => t.function.name === 'browser_act',
    ).function.parameters;
    const validate = new Ajv({ strict: false }).compile(schema);
    assert.equal(validate({ action: 'click', target: '@e2' }), true);
    assert.equal(
      validate({ action: 'press', target: '@e2', value: 'Enter' }),
      false,
    );
    assert.equal(
      validate({ action: 'press', target: '@e1', value: 'Enter' }),
      true,
    );
  } finally {
    await server.close();
  }
});

// 范围：复现大表格控件重复正文挤占 64K 上下文；不以夹具证明真实页面完整或目标可点击。
test('重复控件面板先压缩，保留正文、网络页和取回完整证据的提示', async () => {
  const { args, current } = await input();
  current.text = '当前价格管理弹窗和完整检查正文。'.repeat(80);
  current.targets = Array.from({ length: 70 }, (_, index) => ({
    ...current.targets[0],
    target: `dom-${index}`,
    name: `操作 ${index}`,
    disclosure: {
      relation: 'aria-controls',
      expanded: true,
      visible: true,
      text: '重复表格正文'.repeat(1000),
      truncated: false,
    },
  }));
  current.network = {
    requests: Array.from({ length: 20 }, (_, i) => ({
      url: `https://fixture.test/api/${i}`,
      method: 'GET',
      status: 200,
    })),
  };
  current.artifactRefs.push({
    kind: 'NETWORK',
    artifactId: 'network',
    sha256: 'a'.repeat(64),
  });
  args.evidence.push({
    kind: 'NETWORK',
    id: 'network',
    sha256: 'a'.repeat(64),
  });
  const before = structuredClone(current);
  const result = decisionContext({ ...args, maxContextChars: 64000 });
  assert(result.text.length <= 64000);
  assert.equal(result.context.page.text, current.text);
  assert.equal(result.context.page.network.requests.length, 5);
  assert(result.context.page.targets.length >= 8);
  assert.equal(result.context.page.coverage.controls.detailsTruncated, true);
  assert.match(result.context.page.coverage.recovery, /artifactRefs/);
  assert.equal(
    result.context.page.coverage.text.originalChars,
    current.text.length,
  );
  assert.deepEqual(current, before);
});

// 范围：通过真实 HTTP 请求验证规则随结构化上下文加入及移除；页面与模型回复为夹具，不评估模型遵循能力。
test('专项提示词按每轮事实加载，不残留上一轮规则', async () => {
  const { args, current } = await input();
  const server = await modelServer(() => ({
    type: 'verification.block',
    summary: '检查提示词装配',
  }));
  const model = new ChatModel({ ...config, modelUrl: server.url });
  const send = async (data) => {
    await model.decide(decisionContext(data), new AbortController().signal);
    return server.requests.at(-1).messages[0].content;
  };
  try {
    const minimal = await send(args);
    assert.doesNotMatch(
      minimal,
      /page.network|state.conditions|state.readings|page.documents|history.commands|history.excerpts/,
    );
    assert.doesNotMatch(minimal, /scroll|focusVerified|Service Worker/);
    assert.match(minimal, /不可信证据/);
    assert.match(minimal, /budget 是剩余硬额度/);
    assert.match(minimal, /criteria 按原 criterionId/);

    const rich = await send({
      ...args,
      current: {
        ...current,
        documents: [
          { frameId: 'main', isMainFrame: true, lang: 'en', url: current.url },
        ],
        runtime: { version: 1, status: 'observed' },
      },
      setupPhase: 'CHECKING',
      history: [
        {
          commandId: 'keyboard-fixture',
          operation: 'browser.act',
          action: 'press',
          operationStatus: 'SUCCEEDED',
          effect: 'COMPLETED',
          keyboard: { scope: 'target', focusVerified: true },
        },
      ],
      previousObservations: [{ ...current }],
      // discovered 是裁剪前的稳定计数；正文全部省略时也须保留阅读约束。
      interactionProgress: {
        revision: 1,
        currentTargets: [],
        discovered: 1,
        unreadItemIds: ['item-1'],
        recordedItemIds: [],
        items: [],
        limit: 32,
        omittedItems: 1,
      },
    });
    assert.match(rich, /当前独立核验/);
    assert.doesNotMatch(rich, /当前执行业务验证/);
    assert.match(rich, /state.conditions/);
    assert.match(rich, /state.readings/);
    assert.match(rich, /page.documents/);
    assert.match(rich, /history.commands/);
    assert.match(rich, /history.excerpts/);
    assert.match(rich, /focusVerified/);
    assert.match(rich, /Service Worker/);
    assert.equal(await send(args), minimal);
    assert.deepEqual(server.errors, []);
  } finally {
    await server.close();
  }
});

// 范围：工具说明与最终截图、运行时、阶段和预算能力同步；不执行真实视觉点击或 PWA 清理。
test('动作提示随最终工具能力加载，收尾不再注入浏览器操作规则', async () => {
  const server = await modelServer(() => ({
    type: 'verification.block',
    summary: '检查能力说明',
  }));
  try {
    for (const options of [
      { vision: false, image: true },
      { vision: true, image: false },
      { vision: true, image: true },
      { runtime: true },
      { runtime: true, cleanup: true },
      { runtime: true, settlement: true },
      { actions: 0 },
    ]) {
      const { args, current } = await input();
      if (options.runtime) current.runtime = { version: 1, status: 'observed' };
      if (options.actions === 0) args.budgetRemaining.actions = 0;
      await new ChatModel({
        ...config,
        modelUrl: server.url,
        vision: !!options.vision,
      }).decide(
        decisionContext({
          ...args,
          image: options.image ? 'data:image/png;base64,fixture' : undefined,
          cleanup: !!options.cleanup,
          verificationReview: options.settlement
            ? { final: true, reason: 'budget' }
            : undefined,
        }),
        new AbortController().signal,
      );
      const request = server.requests.at(-1);
      const act = request.tools.find(
        (tool) => tool.function.name === 'browser_act',
      )?.function;
      if (options.settlement || options.actions === 0) {
        assert.equal(act, undefined);
        assert.doesNotMatch(
          request.messages[0].content,
          /scroll|navigate|视觉点击/,
        );
      } else {
        const actions = act.parameters.properties.action.enum;
        const visual = !!(options.vision && options.image);
        assert.equal(actions.includes('visual.click'), visual);
        assert.equal(act.description.includes('视觉点击'), visual);
        assert.equal(
          act.description.includes('online 只派发'),
          !!options.runtime,
        );
        assert.equal(
          act.description.includes('network.probe 的 target'),
          !!options.runtime,
        );
        assert.equal(
          act.description.includes('pwa.cleanup 仅清理'),
          !!options.cleanup,
        );
        assert.match(act.description, /不为确认同一事实反复 navigate/);
      }
    }
    assert.deepEqual(server.errors, []);
  } finally {
    await server.close();
  }
});

// 范围：网络说明依证据开放，收尾仍要求单工具且无并行许可；HTTP 模型夹具不证明供应商遵循提示。
test('网络提示与证据工具保持一致，通用任务不携带正式验收规则', async () => {
  const server = await modelServer(() => ({
    type: 'verification.block',
    summary: '检查网络规则',
  }));
  try {
    for (const withEvidence of [false, true]) {
      const { args, current } = await input();
      args.task.taskKind = 'browser';
      args.task.acceptanceCriteria = [];
      current.network = { requests: [] };
      if (withEvidence) {
        const id = '11111111-1111-4111-8111-111111111111';
        current.artifactRefs.push({
          kind: 'NETWORK',
          artifactId: id,
          sha256: 'a'.repeat(64),
        });
        args.evidence.push({ kind: 'NETWORK', id, sha256: 'a'.repeat(64) });
      }
      await new ChatModel({ ...config, modelUrl: server.url }).decide(
        decisionContext({
          ...args,
          verificationReview: { final: true, reason: 'budget' },
        }),
        new AbortController().signal,
      );
      const request = server.requests.at(-1);
      const prompt = request.messages[0].content;
      assert.equal(
        request.tools.some((tool) => tool.function.name === 'network_requests'),
        withEvidence,
      );
      assert.equal(prompt.includes('page.network 默认'), withEvidence);
      assert.match(prompt, /tool_calls 数组长度必须为 1/);
      assert.match(prompt, /只读查询也遵守此规则/);
      assert.equal(
        prompt.includes('每轮只调用一个 network_requests'),
        withEvidence,
      );
      assert.doesNotMatch(prompt, /最多 4 个纯|允许按下文网络规则组成批次/);
      assert.match(prompt, /只读收尾/);
      assert.match(prompt, /通用浏览器任务/);
      assert.doesNotMatch(prompt, /当前执行业务验证|criteria 按原 criterionId/);
    }
    assert.deepEqual(server.errors, []);
  } finally {
    await server.close();
  }
});

// 范围：共享 context 去重原文、空账本和校验元数据，保留实际要求与可引用身份；不证明模型能正确执行原始任务。
test('context 仅在原文完全相同时引用来源，空阅读和网络账本不加载', async () => {
  const { args, current } = await input();
  const description = '核对名称与提交结果，不新增验收标准。';
  args.task.objective = description;
  args.background = description;
  args.executionStep = {
    stepId: 'setup',
    type: 'setup',
    description,
    url: current.url,
    policy: ['保留当前账号', '不要刷新页面'],
  };
  args.workflow = {
    revision: 0,
    steps: [description, '保留当前账号', '不要刷新页面', '不要刷新页面。'].map(
      (requirement, i) => ({
        id: `req-${i}`,
        requirement,
        status: 'pending',
        evidenceRefs: [],
      }),
    ),
  };
  args.interactionProgress = {
    discovered: 0,
    items: [],
    currentTargets: [],
    recordedItemIds: [],
    unreadItemIds: [],
  };
  const source = structuredClone(args);
  const result = decisionContext(args);
  const delivered = JSON.parse(result.text);
  assert.equal(delivered.task.background, undefined);
  assert.equal(delivered.task.description, description);
  assert.deepEqual(delivered.task.policy, source.executionStep.policy);
  assert.deepEqual(delivered.task.requirements, [
    { id: 'req-0', requirementRef: 'task.description' },
    { id: 'req-1', requirementRef: 'task.policy[0]' },
    { id: 'req-2', requirementRef: 'task.policy[1]' },
    { id: 'req-3', requirement: '不要刷新页面。' },
  ]);
  assert.equal(delivered.state.readings, undefined);
  assert.equal(delivered.state.networkReads, undefined);
  assert.equal(delivered.page.coverage.recovery, undefined);
  assert.deepEqual(
    delivered.page.artifactRefs,
    current.artifactRefs.map(({ artifactId, kind }) => ({ artifactId, kind })),
  );
  assert.deepEqual(args, source);
  assert.deepEqual(delivered, JSON.parse(JSON.stringify(result.context)));
  const distinct = decisionContext({
    ...args,
    background: '包含跨步骤约束的完整原目标',
  }).context;
  assert.equal(distinct.task.background, '包含跨步骤约束的完整原目标');
});

// 范围：历史与当前文本复用但保留历史附件，语言与完整性不同仍独立；不把相同正文视为同一次观察或相同业务状态。
test('历史重复正文复用当前文本，同时保留来源与差异证据', async () => {
  const { args, current, client } = await input();
  const oldId = '22222222-2222-4222-8222-222222222222';
  const docs = [
    { frameId: 'main', isMainFrame: true, lang: 'en', url: current.url },
  ];
  current.documents = docs;
  args.evidence.push({ ...client.artifacts[0], id: oldId });
  const prior = {
    observationId: 'old',
    url: current.url,
    title: current.title,
    documents: docs,
    text: current.text,
    truncated: false,
    artifactRefs: [{ artifactId: oldId, kind: 'DOM', sha256: 'a'.repeat(64) }],
  };
  args.previousObservations = [
    prior,
    {
      ...prior,
      observationId: 'different-language',
      documents: [{ ...docs[0], lang: 'zh-CN' }],
    },
    { ...prior, observationId: 'partial', truncated: true },
  ];
  const before = structuredClone(args);
  const result = decisionContext(args).context;
  assert.equal(result.history.excerpts.length, 3);
  assert.equal(result.history.excerpts[0].text, undefined);
  assert.equal(result.history.excerpts[0].textRef, 'page.text');
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.history.excerpts[0].artifactRefs)),
    [{ artifactId: oldId, kind: 'DOM' }],
  );
  for (const item of result.history.excerpts.slice(1)) {
    assert.equal(item.text, current.text);
    assert.equal(item.textRef, undefined);
  }
  assert(result.evidence.some((item) => item.id === oldId));
  assert.deepEqual(args, before);
});

// 范围：初次网络只交付预览，主动查询交付完整分页和零匹配回执，新观察恢复预览；所有网络内容均为夹具。
test('网络 context 默认小预览，查询后按需展开且不改变原始采集', async () => {
  const { args, current, client } = await input();
  const id = '33333333-3333-4333-8333-333333333333';
  current.network = {
    complete: true,
    truncated: false,
    requests: Array.from({ length: 40 }, (_, i) => ({
      url: `https://fixture.test/item-${i}`,
      method: 'GET',
      status: 200,
    })),
  };
  current.artifactRefs.push({
    artifactId: id,
    kind: 'NETWORK',
    sha256: 'a'.repeat(64),
  });
  client.artifacts.push({ id, kind: 'NETWORK', sha256: 'a'.repeat(64) });
  const before = structuredClone(args);
  const preview = decisionContext(args).context.page.network;
  assert.equal(preview.total, 40);
  assert.equal(preview.requests.length, 5);
  assert.equal(preview.nextOffset, 5);
  assert.equal(preview.omitted, 35);
  assert.equal(preview.capture.complete, true);
  const queried = decisionContext({
    ...args,
    networkSelection: {
      observationId: current.observationId,
      offset: preview.nextOffset,
    },
  }).context.page.network;
  assert.equal(queried.requests.length, 20);
  assert.equal(queried.requests[0].url, current.network.requests[5].url);
  assert.equal(queried.nextOffset, 25);
  const empty = decisionContext({
    ...args,
    networkSelection: { observationId: current.observationId, status: 404 },
  }).context.page.network;
  assert.equal(empty.matched, 0);
  assert.deepEqual(empty.requests, []);
  assert.equal(empty.nextOffset, null);
  const stale = decisionContext({
    ...args,
    networkSelection: { observationId: 'old-observation', offset: 20 },
  }).context.page.network;
  assert.deepEqual(stale, preview);
  assert.deepEqual(args, before);
});

// 范围：实际交付截图时保留决定帧所需哈希，文字轮次不携带；这里只验证投影，不代替图片下载及字节完整性校验。
test('截图校验元数据仅随实际图片交付保留', async () => {
  const { args, current, client } = await input();
  const id = '44444444-4444-4444-8444-444444444444';
  const sha256 = 'b'.repeat(64);
  current.artifactRefs.push({ artifactId: id, kind: 'SCREENSHOT', sha256 });
  client.artifacts.push({ id, kind: 'SCREENSHOT', sha256 });
  const textOnly = JSON.parse(decisionContext(args).text);
  assert(textOnly.page.artifactRefs.every((item) => item.sha256 === undefined));
  const withImage = decisionContext({
    ...args,
    image: 'data:image/png;base64,fixture',
  }).context;
  assert.equal(
    withImage.page.artifactRefs.find((item) => item.artifactId === id).sha256,
    sha256,
  );
  assert(
    withImage.page.artifactRefs
      .filter((item) => item.kind !== 'SCREENSHOT')
      .every((item) => item.sha256 === undefined),
  );
  assert.equal(
    current.artifactRefs.find((item) => item.artifactId === id).sha256,
    sha256,
  );
});

// 范围：真实适配器的 HTTP 等待受步骤剩余模型时限约束，失败仍完整记账且不隐式重试；挂起回复是夹具，不评估供应商延迟。
test('模型连接修复仍服从更短的步骤期限并记录超时', async () => {
  const { args } = await input();
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const server = await modelServer(async () => {
    await waiting;
    return { type: 'verification.block', summary: '仅验证期限' };
  });
  const receipts = [];
  let requests = 0;
  try {
    const started = performance.now();
    await assert.rejects(
      new ChatModel({
        ...config,
        modelUrl: server.url,
        modelMs: 600_000,
      }).decide(
        {
          ...decisionContext(args),
          modelDeadline: started + 200,
          recordRequest: () => {
            requests++;
          },
          traceRequest: async () => async (receipt) => {
            receipts.push(receipt);
          },
        },
        new AbortController().signal,
      ),
      { code: 'TRANSPORT_REQUEST_TIMEOUT' },
    );
    assert.ok(performance.now() - started < 2000);
    assert.equal(requests, 1);
    assert.equal(server.requests.length, 1);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, 'ERROR');
    assert.equal(receipts[0].error, 'TRANSPORT_REQUEST_TIMEOUT');
    assert.equal(receipts[0].response, null);
  } finally {
    release();
    await server.close();
  }
});

// 范围：HTTP 出站与审计保留，双动作或动作附带观察均整批拒绝且无隐式重试；回复是夹具，实际模型遵从率由真实基准验证。
for (const extraTool of ['browser_act', 'browser_observe'])
  test(`首轮动作附带 ${extraTool} 保持原文并整批拒绝，单调用约束进入实际请求`, async () => {
    const { args } = await input();
    const calls = ['first-field', 'second-field'].map((target) => ({
      type: 'function',
      function: {
        name: 'browser_act',
        arguments: JSON.stringify({
          action: 'fill',
          target,
          value: 'synthetic',
        }),
      },
    }));
    if (extraTool === 'browser_observe')
      calls[1].function = { name: extraTool, arguments: '{}' };
    const reply = {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: { role: 'assistant', tool_calls: calls },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    };
    const server = await modelServer(() => ({ raw: reply }));
    const receipts = [];
    let sent,
      count = 0;
    try {
      await assert.rejects(
        new ChatModel({
          ...config,
          modelUrl: server.url,
          thinking: 'enabled',
          reasoningEffort: 'high',
        }).decide(
          {
            ...decisionContext(args),
            recordRequest: () => {
              count++;
            },
            traceRequest: async (record) => {
              sent = JSON.parse(record.request);
              return async (receipt) => {
                receipts.push(receipt);
              };
            },
          },
          new AbortController().signal,
        ),
        { code: 'INVALID_MODEL_DECISION' },
      );
      assert.equal(server.requests.length, 1);
      assert.equal(count, 1);
      assert.deepEqual(sent, server.requests[0]);
      assert.equal(sent.parallel_tool_calls, false);
      assert.equal(sent.tool_choice, 'auto');
      assert.equal(sent.thinking.type, 'enabled');
      assert.match(sent.messages[0].content, /tool_calls 数组长度必须为 1/);
      assert.match(sent.messages[0].content, /这种回复会整批拒绝/);
      assert.match(
        sent.messages[0].content,
        /调用 browser_act 后不要追加 browser_observe/,
      );
      assert(sent.messages[0].content.endsWith('下一步只能在下一轮决定。'));
      assert.doesNotMatch(sent.messages[0].content, /特殊批次|最多 4 个纯/);
      assert.match(
        sent.tools.find((tool) => tool.function.name === 'browser_act').function
          .description,
        /填写多个字段也必须拆到不同轮次/,
      );
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].status, 'RECEIVED');
      assert.deepEqual(
        JSON.parse(receipts[0].response).choices[0].message.tool_calls,
        calls,
      );
      assert.deepEqual(server.errors, []);
    } finally {
      await server.close();
    }
  });

// 范围：工具 schema 随真实 context 开关阅读入口，防止普通核验误填 itemId；HTTP 模型是夹具，不证明真实模型质量或引文真实性。
test('没有面板账本时不提供 readings，存在或裁剪后的账本保留原校验入口', async () => {
  const { args } = await input();
  const server = await modelServer(() => ({
    type: 'verification.block',
    summary: '只验证出站能力',
  }));
  const model = new ChatModel({ ...config, modelUrl: server.url });
  try {
    for (const discovered of [0, 1, 0]) {
      await model.decide(
        decisionContext({
          ...args,
          interactionProgress: {
            revision: 0,
            currentTargets: [],
            discovered,
            unreadItemIds: discovered ? ['item-1'] : [],
            recordedItemIds: [],
            items: [],
            limit: 32,
            omittedItems: discovered,
          },
        }),
        new AbortController().signal,
      );
      const request = server.requests.at(-1);
      for (const tool of request.tools) {
        const progress = tool.function.parameters.properties.progress;
        assert.equal(
          Object.hasOwn(progress.properties, 'readings'),
          discovered > 0,
        );
        assert.equal(progress.additionalProperties, false);
        const ajv = new Ajv({ strict: false });
        const validate = ajv.compile(progress);
        assert.equal(
          validate({ readings: [{ itemId: 'invented', quote: 'synthetic' }] }),
          discovered > 0,
        );
      }
      if (discovered) {
        assert.match(request.messages[0].content, /progress\.readings 内/);
        assert.match(request.messages[0].content, /不要把 name、heading/);
      }
      assert.equal(
        request.messages[0].content.includes('本轮没有子项阅读账本'),
        discovered === 0,
      );
    }
    assert.deepEqual(server.errors, []);
  } finally {
    await server.close();
  }
});
