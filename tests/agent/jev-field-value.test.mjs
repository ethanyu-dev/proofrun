import assert from 'node:assert/strict';
import test from 'node:test';
import { JevModel } from '../../apps/agent/dist/model/jev.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { AgentFault } from '../../apps/agent/dist/http.js';
import { config, grant, modelServer } from './fixture.mjs';

/** 填写候选和页面均为夹具；不访问真实邀请码或账号服务。 */
function input() {
  return {
    text: JSON.stringify({
      task: {
        ...grant().task,
        objective: '输入无效邀请码检查提示，不提交或注册',
      },
      observation: {
        observationId: 'field',
        url: 'https://fixture.test/form',
        title: '填写',
        text: '输入邀请码',
        atomic: false,
        artifactRefs: [],
        targets: [{ target: 'field-1', role: 'textbox', name: '邀请码' }],
      },
      recentOperations: [],
      previousObservations: [],
      evidence: [],
      feedback: null,
      budgetRemaining: { actions: 10 },
    }),
  };
}

/** 返回完整候选概率与指定字段回复；用于验证适配器和子请求记账。 */
function requestWith(content) {
  return async (_url, _key, _method, body) => {
    if (body.questions) {
      const entries = Object.entries(body.questions.next.criteria);
      const choice = entries.find(
        ([, item]) => item.operation === 'TYPE_TEXT',
      )[0];
      return {
        answers: {
          next: {
            choice,
            confidence: 1,
            probabilities: Object.fromEntries(
              entries.map(([id]) => [id, Number(id === choice)]),
            ),
          },
        },
        usage: { input_tokens: 3, output_tokens: 2 },
      };
    }
    return {
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 5, completion_tokens: 4 },
    };
  };
}

// 范围：填写回执后先核对提示且不重复审查同一回执；仅模拟选择失焦动作，不证明真实页面会出现提示。
test('JEV 填写后先交给文本模型核对校验状态', async () => {
  let selections = 0,
    reviews = 0;
  const request = requestWith('{"text":"fixture-invalid"}');
  const model = new JevModel(
    config,
    'fixture',
    'jev-test',
    async (...args) => {
      selections++;
      return request(...args);
    },
    {
      async decide(input) {
        reviews++;
        const context = JSON.parse(input.text);
        assert.match(context.feedback, /字段填写已成功/);
        assert.equal(context.observation.targets[0].value, 'fixture-invalid');
        return {
          decision: { type: 'browser.act', action: 'press', value: 'Tab' },
          promptTokens: 1,
          completionTokens: 1,
        };
      },
    },
  );
  const context = JSON.parse(input().text);
  context.observation.targets[0].value = 'fixture-invalid';
  context.recentOperations = [
    {
      commandId: 'fill-1',
      operation: 'browser.act',
      action: 'fill',
      operationStatus: 'SUCCEEDED',
      effect: 'COMPLETED',
    },
    {
      commandId: 'observe-1',
      operation: 'browser.observe',
      operationStatus: 'SUCCEEDED',
      effect: 'COMPLETED',
    },
  ];
  const output = await model.decide(
    { text: JSON.stringify(context) },
    new AbortController().signal,
  );
  assert.equal(output.decision.value, 'Tab');
  assert.equal(selections, 0);
  assert.equal(reviews, 1);
  await model.decide(
    { text: JSON.stringify(context) },
    new AbortController().signal,
  );
  assert.equal(reviews, 1);
  assert(selections > 0);
});

// 范围：null 转入完整文本决策，可生成测试输入或明确阻塞，所有请求及用量可追踪；不验证真实模型生成质量。
test('JEV 字段缺少信息时重新规划，并保留模型调用预算和回执', async (t) => {
  for (const result of ['fill', 'block'])
    await t.test(result, async () => {
      const expected =
        result === 'fill'
          ? {
              type: 'browser.act',
              action: 'fill',
              target: 'field-1',
              value: 'invalid-fixture-code',
            }
          : {
              type: 'verification.block',
              summary: '缺少必要测试数据',
              reasonCode: 'OTHER',
            };
      const server = await modelServer((context) => {
        assert.match(context.feedback, /text=null/);
        assert.match(context.feedback, /尚未执行填写/);
        assert.match(context.task.objective, /不提交或注册/);
        return expected;
      });
      try {
        const settings = { ...config, modelUrl: server.url };
        const model = new JevModel(
          settings,
          'fixture',
          'jev-test',
          requestWith('{"text":null}'),
          new ChatModel(settings),
        );
        const decisionInput = input();
        const records = [],
          calls = [],
          usage = [];
        decisionInput.traceRequest = async (record) => {
          const entry = { record };
          records.push(entry);
          return async (receipt) => {
            entry.receipt = receipt;
          };
        };
        decisionInput.recordRequest = (model) => calls.push(model);
        decisionInput.recordUsage = (_model, prompt, completion) =>
          usage.push([prompt, completion]);
        const output = await model.decide(
          decisionInput,
          new AbortController().signal,
        );
        assert.deepEqual(output.decision, expected);
        assert.deepEqual(
          records.map((entry) => entry.record.purpose),
          ['JEV_SELECTION', 'FIELD_VALUE', 'DECISION'],
        );
        assert(records.every((entry) => entry.receipt.status === 'RECEIVED'));
        assert.equal(calls.length, 3);
        assert.deepEqual(usage, [
          [3, 2],
          [5, 4],
          [20, 10],
        ]);
        assert.equal(output.promptTokens, 28);
        assert.equal(output.completionTokens, 16);
        assert.equal(server.requests.length, 1);
        assert.deepEqual(server.errors, []);
      } finally {
        await server.close();
      }
    });
});

// 范围：恢复调用仍服从同一个请求预算，不能偷偷多发 HTTP；不覆盖控制面持久化实现。
test('JEV 字段恢复不能绕过模型请求预算', async () => {
  const server = await modelServer(() =>
    assert.fail('预算耗尽后不应派发恢复请求'),
  );
  try {
    const settings = { ...config, modelUrl: server.url };
    const model = new JevModel(
      settings,
      'fixture',
      'jev-test',
      requestWith('{"text":null}'),
      new ChatModel(settings),
    );
    const decisionInput = input();
    let calls = 0;
    decisionInput.recordRequest = () => {
      if (++calls > 2)
        throw new AgentFault('STEP_MODEL_BUDGET_EXCEEDED', '夹具预算耗尽');
    };
    await assert.rejects(
      model.decide(decisionInput, new AbortController().signal),
      { code: 'STEP_MODEL_BUDGET_EXCEEDED' },
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

// 范围：只有协议允许的 null 进入缺失信息恢复，畸形 JSON 和越界类型仍拒绝；不验证供应商实际回复。
test('非法字段回复仍归类为决策校验错误', async () => {
  for (const content of [
    'bad json',
    '{}',
    '{"text":42}',
    JSON.stringify({ text: 'x'.repeat(8193) }),
  ]) {
    const model = new JevModel(
      config,
      'fixture',
      'jev-test',
      requestWith(content),
      {
        decide: async () => assert.fail('格式错误不应伪装成缺失信息'),
      },
    );
    await assert.rejects(model.decide(input(), new AbortController().signal), {
      code: 'INVALID_MODEL_DECISION',
    });
  }
});
