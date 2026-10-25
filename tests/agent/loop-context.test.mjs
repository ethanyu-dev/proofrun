import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decisionContext,
  rememberObservation,
} from '../../apps/agent/dist/execution/context.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { Workflow } from '../../apps/agent/dist/execution/workflow.js';
import { observation } from '../../apps/agent/dist/evidence/observation.js';
import { config, grant, FakeControl, modelServer } from './fixture.mjs';

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
    assert.equal(out.workflow.assessments[0].outcome, 'incomplete');
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
