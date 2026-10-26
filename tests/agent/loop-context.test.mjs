import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  decisionContext,
  rememberObservation,
} from '../../apps/agent/dist/execution/context.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { Workflow } from '../../apps/agent/dist/execution/workflow.js';
import { observation } from '../../apps/agent/dist/evidence/observation.js';
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
    current: { ...current, documents },
    previousObservations: history,
  }).context;
  assert.equal(result.page.documents[0].lang, 'en');
  assert.deepEqual(
    result.history.excerpts.map((item) => item.documents[0].lang),
    ['zh-CN', 'en'],
  );
  assert.deepEqual(
    result.history.excerpts[0].artifactRefs,
    current.artifactRefs,
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
