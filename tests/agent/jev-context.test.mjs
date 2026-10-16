import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { JevModel } from '../../apps/agent/dist/model/jev.js';
import { estimatedTokens } from '../../apps/agent/dist/model/candidates.js';
import { AgentFault, jsonRequest } from '../../apps/agent/dist/http.js';
import { config } from './fixture.mjs';

/** 只构造合成页面与目标；不包含真实账号、站点证据或验收结论。 */
function input(text = '选择继续', count = 1, extra = {}) {
  return {
    text: JSON.stringify({
      task: { taskId: 'context-fixture', objective: '选择继续' },
      observation: {
        observationId: 'context-page',
        url: 'https://fixture.test/context',
        title: '上下文夹具',
        text,
        atomic: false,
        artifactRefs: [],
        targets: Array.from({ length: count }, (_, i) => ({
          target: `button-${i}`,
          role: 'button',
          name: `继续 ${i}`,
        })),
      },
      recentOperations: [],
      feedback: null,
      budgetRemaining: { actions: 10 },
      ...extra,
    }),
  };
}

/** 概率只用于驱动适配器分支，不能表示供应商置信度或真实任务正确率。 */
function answer(body) {
  return {
    model: 'jev-1.14.0',
    answers: {
      next: {
        choice: 'A1',
        confidence: 1,
        probabilities: Object.fromEntries(
          Object.keys(body.questions.next.criteria).map((id) => [
            id,
            Number(id === 'A1'),
          ]),
        ),
      },
    },
    usage: { input_tokens: 10, output_tokens: 0 },
  };
}

/** 记录请求与审查分支；预算使用真实适配器，模型回复使用合成夹具。 */
function harness(long = false, send) {
  const calls = [],
    reviews = [];
  const model = new JevModel(
    { ...config, maxContextChars: 256_000, jevLongContext: long },
    'fixture-key',
    undefined,
    async (...args) => {
      calls.push({ body: structuredClone(args[3]), headers: args[6] });
      return send ? send(...args) : answer(args[3]);
    },
    {
      decide: async (request) => {
        reviews.push(JSON.parse(request.text));
        return {
          decision: { type: 'browser.observe' },
          promptTokens: 0,
          completionTokens: 0,
        };
      },
    },
  );
  return { model, calls, reviews };
}
/** 每轮决策独立取消域，避免测试之间共享中止状态。 */
const signal = () => new AbortController().signal;

// 范围：默认版本固定、旧预算保留、审计保存实际模型；不验证真实供应商可用性或模型能力。
test('JEV 默认固定 1.14 并保留普通上下文预算', async () => {
  const { model, calls } = harness();
  const request = input('正文材料'.repeat(10_000));
  let receipt;
  request.traceRequest = async () => async (result) => {
    receipt = result;
  };
  await model.decide(request, signal());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.model, 'jev-1.14.0');
  assert.equal(calls[0].headers, undefined);
  assert(calls[0].body.state.observation.text.length <= 14_000);
  assert(calls[0].body.state.observation.textTruncated);
  assert(estimatedTokens(calls[0].body) <= 28_000);
  assert(JSON.stringify(calls[0].body).length <= 64_000);
  assert.equal(JSON.parse(receipt.response).model, 'jev-1.14.0');
});

// 范围：显式开关保留更多当前正文，短请求不加实验头，fork 继承策略；不验证长文准确率。
test('JEV 长上下文按需发送实验头并继承到独立 tab', async () => {
  const { model, calls } = harness(true);
  await model.decide(input(), signal());
  assert.equal(calls[0].headers, undefined);
  const text = '正文材料'.repeat(10_000);
  await model.fork().decide(input(text), signal());
  assert.equal(calls[1].body.state.observation.text, text);
  assert.equal(calls[1].body.state.observation.textTruncated, false);
  assert(estimatedTokens(calls[1].body) > 28_000);
  assert.deepEqual(calls[1].headers, {
    'TypeSafe-Danger-Zone-Long-Context': 'true',
  });
});

// 范围：长模式仍限制页长、请求大小、token 和候选数，并披露缺口；不保证全部 DOM 进入模型。
test('JEV 长上下文仍保留有限候选和裁剪保护', async () => {
  const { model, calls } = harness(true);
  await model.decide(input('正文材料'.repeat(30_000), 300), signal());
  const body = calls[0].body;
  assert(body.state.observation.text.length <= 64_000);
  assert.equal(body.state.observation.textTruncated, true);
  assert.equal(body.state.candidateCoverage.returnedActions, 200);
  assert.equal(body.state.candidateCoverage.omittedActions, 100);
  assert.equal(Object.keys(body.questions.next.criteria).length, 205);
  assert(estimatedTokens(body) <= 224_000);
  assert(JSON.stringify(body).length <= 256_000);
});

// 范围：长模式超出估算预算时本地转交审查，不派发超限请求；审查器为夹具，不验证文本模型容量。
test('JEV 长上下文超出预算仍回退且不裁剪原始任务', async () => {
  const { model, calls, reviews } = harness(true);
  const objective = '原始定义'.repeat(30_000);
  await model.decide(
    input('继续', 10, { task: { taskId: 'large', objective } }),
    signal(),
  );
  assert.equal(calls.length, 0);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].task.objective, objective);
  assert.match(reviews[0].feedback, /超过 JEV 请求预算/);
});

// 范围：长模式服务端拒绝仍交接审查，身份错误仍失败；不把 HTTP 451 等拒绝误判为上下文问题。
test('JEV 长上下文服务拒绝保留原有错误分类', async () => {
  for (const [code, status] of [
    ['MODEL_CONTEXT_TOO_LARGE', 400],
    ['HTTP_ERROR', 451],
  ]) {
    const { model, calls, reviews } = harness(true, async () => {
      throw new AgentFault(code, '夹具拒绝', status);
    });
    const action = model.decide(input('正文材料'.repeat(10_000)), signal());
    if (code === 'MODEL_CONTEXT_TOO_LARGE') {
      await action;
      assert.equal(reviews.length, 1);
    } else {
      await assert.rejects(action, { code, status });
      assert.equal(reviews.length, 0);
    }
    assert.equal(calls.length, 1);
  }
});

// 范围：实际 HTTP 序列化携带实验头且不跨请求残留；仅连接本地服务器，不验证 TypeSafe 服务。
test('附加实验头只作用于本次 HTTP 请求', async () => {
  const headers = [];
  const server = createServer((request, response) => {
    headers.push(request.headers);
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    await jsonRequest(url, 'fixture-key', 'POST', {}, 2000, signal(), {
      'TypeSafe-Danger-Zone-Long-Context': 'true',
    });
    await jsonRequest(url, 'fixture-text-key', 'POST', {}, 2000, signal());
    assert.equal(headers[0]['typesafe-danger-zone-long-context'], 'true');
    assert.equal(headers[0].authorization, 'Bearer fixture-key');
    assert.equal(headers[1]['typesafe-danger-zone-long-context'], undefined);
    assert.equal(headers[1].authorization, 'Bearer fixture-text-key');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

// 范围：长正文引发实验头后，填写子请求不继承该头；全部模型回复是夹具，不验证真实填写效果。
test('JEV 实验头不传播到文本填写模型', async () => {
  const { model, calls } = harness(true, async (_url, _key, _method, body) =>
    body.questions
      ? answer(body)
      : {
          choices: [{ message: { content: '{"text":"fixture-value"}' } }],
        },
  );
  const request = input('正文材料'.repeat(10_000));
  const context = JSON.parse(request.text);
  context.observation.targets[0].role = 'textbox';
  request.text = JSON.stringify(context);
  const output = await model.decide(request, signal());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['TypeSafe-Danger-Zone-Long-Context'], 'true');
  assert.equal(calls[1].headers, undefined);
  assert.equal(output.decision.value, 'fixture-value');
});

// 范围：上游已截断的正文不能因适配器未再次截断而被标为完整；不验证节点采集覆盖率。
test('JEV 保留上游正文截断事实', async () => {
  const { model, calls } = harness(true);
  const request = input();
  const context = JSON.parse(request.text);
  context.observation.truncated = true;
  request.text = JSON.stringify(context);
  await model.decide(request, signal());
  assert.equal(calls[0].body.state.observation.textTruncated, true);
});

// 范围：记账和定位提示不重复请求文本复核；计划耗尽、取证与故障路径另有测试。
test('公共进度提示不打断仍有效的 JEV 动作计划', async () => {
  for (const review of [
    'TASK_PROGRESS',
    'TARGET_LOCATED',
    'BUDGET_LOW',
    'WORK_BUDGET_LOW',
  ]) {
    const { model, calls, reviews } = harness();
    const request = input('选择继续', 1, {
      executionGuidance: { review },
      workflow: {
        revision: 0,
        activeStep: 's',
        steps: [{ id: 's', requirement: '选择继续' }],
        recovery: {
          goal: '选择继续',
          scope: '',
          terms: ['继续'],
          successCondition: '进入下一页',
          remaining: 2,
        },
      },
    });
    await model.decide(request, signal());
    assert.equal(calls.length, 1, review);
    assert.equal(reviews.length, 0, review);
  }
});
