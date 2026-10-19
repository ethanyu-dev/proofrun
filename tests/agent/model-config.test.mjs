import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { loadConfig } from '../../apps/agent/dist/config.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { config, modelServer } from './fixture.mjs';

/** 配置测试仅注入本地夹具凭据，结束后恢复进程环境。 */
function configure(t) {
  const values = {
    PROOFRUN_WORKER_TOKEN: config.workerToken,
    PROOFRUN_WORKER_ID: config.workerId,
    PROOFRUN_MODEL_API_KEY: config.modelKey,
    PROOFRUN_MODEL: config.model,
    PROOFRUN_MODEL_BASE_URL: 'http://127.0.0.1:4101/v1',
    PROOFRUN_MODEL_THINKING: undefined,
    PROOFRUN_MODEL_REASONING_EFFORT: undefined,
    PROOFRUN_MODEL_MAX_TOKENS: undefined,
    PROOFRUN_AGENT_MODEL_MS: undefined,
    PROOFRUN_JEV_LONG_CONTEXT: undefined,
    PROOFRUN_JEV_IMAGES: undefined,
    PROOFRUN_JEV_BOX: undefined,
    PROOFRUN_JEV_EXPANDED_ACTIONS: undefined,
    PROOFRUN_AGENT_EXECUTION_GUIDANCE: undefined,
    PROOFRUN_AGENT_EXECUTION_POLICY: undefined,
    PROOFRUN_AGENT_COMMAND_MS: undefined,
    PROOFRUN_AGENT_EVIDENCE_MS: undefined,
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  const apply = (entries) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  t.after(() => apply(previous));
  apply(values);
}

// 范围：环境配置的默认兼容、显式值和拼写错误；不证明供应商支持开启思考后的工具调用。
test('思考模式默认不覆盖供应商并拒绝非法配置', (t) => {
  configure(t);
  assert.equal(loadConfig().thinking, undefined);
  for (const mode of ['default', 'enabled', 'disabled']) {
    process.env.PROOFRUN_MODEL_THINKING = mode;
    assert.equal(loadConfig().thinking, mode === 'default' ? undefined : mode);
  }
  for (const mode of ['', 'false', 'DISABLED', 'disable']) {
    process.env.PROOFRUN_MODEL_THINKING = mode;
    assert.throws(() => loadConfig(), /PROOFRUN_MODEL_THINKING/);
  }
});

// 范围：实验能力显式开启、非法值及 Box 依赖；不验证服务账户是否支持这些能力。
test('JEV 图片、Box 和候选扩展独立配置并校验依赖', (t) => {
  configure(t);
  assert.equal(loadConfig().jevImages, false);
  assert.equal(loadConfig().jevBox, false);
  assert.equal(loadConfig().jevExpandedActions, false);
  process.env.PROOFRUN_JEV_BOX = 'true';
  assert.throws(() => loadConfig(), /requires PROOFRUN_JEV_IMAGES/);
  process.env.PROOFRUN_JEV_IMAGES = 'true';
  assert.equal(loadConfig().jevBox, true);
  for (const name of [
    'PROOFRUN_JEV_IMAGES',
    'PROOFRUN_JEV_BOX',
    'PROOFRUN_JEV_EXPANDED_ACTIONS',
  ]) {
    const previous = process.env[name];
    process.env[name] = 'enabled';
    assert.throws(() => loadConfig(), new RegExp(name));
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

// 范围：长推理预算的默认值、显式上界及越界拒绝；不证明真实模型会在该预算内结束。
test('长推理允许显式提高输出与时限且保持有界', (t) => {
  configure(t);
  assert.equal(loadConfig().maxTokens, 4096);
  assert.equal(loadConfig().modelMs, 30000);
  process.env.PROOFRUN_MODEL_MAX_TOKENS = '65536';
  process.env.PROOFRUN_AGENT_MODEL_MS = '600000';
  assert.equal(loadConfig().maxTokens, 65536);
  assert.equal(loadConfig().modelMs, 600000);
  process.env.PROOFRUN_MODEL_MAX_TOKENS = '65537';
  assert.throws(() => loadConfig(), /PROOFRUN_MODEL_MAX_TOKENS/);
  process.env.PROOFRUN_MODEL_MAX_TOKENS = '65536';
  process.env.PROOFRUN_AGENT_MODEL_MS = '600001';
  assert.throws(() => loadConfig(), /PROOFRUN_AGENT_MODEL_MS/);
});

// 范围：推理档位默认省略、非法值和独立关闭开关；不证明网关实际使用所请求的档位。
test('推理强度保留配置并允许独立关闭思考', (t) => {
  configure(t);
  assert.equal(loadConfig().reasoningEffort, undefined);
  for (const value of ['default', 'low', 'high', 'max']) {
    process.env.PROOFRUN_MODEL_REASONING_EFFORT = value;
    assert.equal(
      loadConfig().reasoningEffort,
      value === 'default' ? undefined : value,
    );
  }
  for (const value of ['', 'MAX', 'xhigh', 'none']) {
    process.env.PROOFRUN_MODEL_REASONING_EFFORT = value;
    assert.throws(() => loadConfig(), /PROOFRUN_MODEL_REASONING_EFFORT/);
  }
  process.env.PROOFRUN_MODEL_REASONING_EFFORT = 'max';
  process.env.PROOFRUN_MODEL_THINKING = 'disabled';
  assert.equal(loadConfig().thinking, 'disabled');
  assert.equal(loadConfig().reasoningEffort, 'max');
  process.env.PROOFRUN_MODEL_THINKING = 'enabled';
  assert.equal(loadConfig().reasoningEffort, 'max');
});

// 范围：本地 HTTP 与审计正文均携带 max；auto 返回的普通文字仍拒绝，不验证真实模型效果。
test('max 贯通请求与存档且不放宽回复的单工具约束', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: '已完成' },
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    let recorded;
    await assert.rejects(
      new ChatModel({
        ...config,
        modelUrl: `http://127.0.0.1:${server.address().port}`,
        reasoningEffort: 'max',
      }).decide(
        {
          text: '{}',
          traceRequest: async (record) => {
            recorded = JSON.parse(record.request);
            return async () => {};
          },
        },
        new AbortController().signal,
      ),
      { code: 'INVALID_MODEL_DECISION' },
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].reasoning_effort, 'max');
    assert.equal(requests[0].tool_choice, 'auto');
    assert.deepEqual(recorded, requests[0]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

// 范围：本地 HTTP 正文、审计存档和关闭开关对 max 的优先级；夹具不证明真实模型效果。
test('Chat Completions 显式思考使用 auto，默认与关闭思考保留 required', async () => {
  const server = await modelServer(() => ({
    type: 'browser.observe',
    screenshot: false,
  }));
  try {
    for (const [thinking, reasoningEffort, expectedToolChoice] of [
      [undefined, undefined, 'required'],
      ['enabled', undefined, 'auto'],
      ['disabled', undefined, 'required'],
      ['disabled', 'max', 'required'],
    ]) {
      let recorded;
      const model = new ChatModel({
        ...config,
        modelUrl: server.url,
        thinking,
        reasoningEffort,
      });
      const output = await model.decide(
        {
          text: '{}',
          traceRequest: async (record) => {
            recorded = JSON.parse(record.request);
            return async () => {};
          },
        },
        new AbortController().signal,
      );
      const body = server.requests.at(-1);
      assert.deepEqual(recorded, body);
      assert.equal(Object.hasOwn(body, 'thinking'), thinking !== undefined);
      assert.deepEqual(
        body.thinking,
        thinking ? { type: thinking } : undefined,
      );
      assert.equal(body.tool_choice, expectedToolChoice);
      assert.equal(body.reasoning_effort, reasoningEffort);
      assert.equal(body.parallel_tool_calls, false);
      assert.equal(output.decision.type, 'browser.observe');
    }
    assert.deepEqual(server.errors, []);
  } finally {
    await server.close();
  }
});

// 范围：本地 HTTP 夹具重现默认思考与强制工具的 400 冲突；不连接 DeepSeek 或业务浏览器。
test('关闭思考模式后通过默认思考服务的工具请求校验', async (t) => {
  configure(t);
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    response.setHeader('content-type', 'application/json');
    if (body.tool_choice === 'required' && body.thinking?.type !== 'disabled') {
      response
        .writeHead(400)
        .end(JSON.stringify({ error: { message: '思考模式不支持强制工具' } }));
      return;
    }
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  type: 'function',
                  function: {
                    name: 'browser_observe',
                    arguments: '{"screenshot":false}',
                  },
                },
              ],
            },
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const modelUrl = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const input = { text: '{}' };
    const signal = new AbortController().signal;
    await assert.rejects(
      new ChatModel({ ...loadConfig(), modelUrl }).decide(input, signal),
      {
        code: 'HTTP_ERROR',
        status: 400,
      },
    );
    process.env.PROOFRUN_MODEL_THINKING = 'disabled';
    const output = await new ChatModel({ ...loadConfig(), modelUrl }).decide(
      input,
      signal,
    );
    assert.deepEqual(output.decision, {
      type: 'browser.observe',
      screenshot: false,
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

// 范围：证据预算独立默认值、覆盖及边界；不覆盖真实上传或 Railway 配置注入。
test('证据预算独立于命令预算并拒绝非法时限', (t) => {
  configure(t);
  assert.equal(loadConfig().evidenceMs, 60000);
  process.env.PROOFRUN_AGENT_COMMAND_MS = '1000';
  assert.equal(loadConfig().evidenceMs, 60000);
  for (const value of ['100', '90000', '300000']) {
    process.env.PROOFRUN_AGENT_EVIDENCE_MS = value;
    assert.equal(loadConfig().evidenceMs, Number(value));
  }
  for (const value of ['', '0', '99', '300001', '1.5', 'invalid']) {
    process.env.PROOFRUN_AGENT_EVIDENCE_MS = value;
    assert.throws(() => loadConfig(), /PROOFRUN_AGENT_EVIDENCE_MS/);
  }
});

// 范围：实验上下文必须显式开启且拒绝拼写错误；不证明供应商接受更大上下文。
test('JEV 长上下文默认关闭并严格解析开关', (t) => {
  configure(t);
  assert.equal(loadConfig().jevLongContext, false);
  for (const value of ['true', 'false']) {
    process.env.PROOFRUN_JEV_LONG_CONTEXT = value;
    assert.equal(loadConfig().jevLongContext, value === 'true');
  }
  for (const value of ['', '1', 'TRUE', 'enabled']) {
    process.env.PROOFRUN_JEV_LONG_CONTEXT = value;
    assert.throws(() => loadConfig(), /PROOFRUN_JEV_LONG_CONTEXT/);
  }
});

// 范围：legacy 下通用执行策略独立开关及错误配置拒绝；不验证模型效果。
test('通用执行策略独立开关不改变模型和预算配置', (t) => {
  configure(t);
  process.env.PROOFRUN_AGENT_EXECUTION_POLICY = 'legacy';
  const before = loadConfig();
  assert.equal(before.executionGuidance, false);
  process.env.PROOFRUN_AGENT_EXECUTION_GUIDANCE = 'true';
  const enabled = loadConfig();
  assert.equal(enabled.executionGuidance, true);
  assert.equal(enabled.model, before.model);
  assert.equal(enabled.maxTurns, before.maxTurns);
  process.env.PROOFRUN_AGENT_EXECUTION_GUIDANCE = 'enabled';
  assert.throws(() => loadConfig(), /PROOFRUN_AGENT_EXECUTION_GUIDANCE/);
});

// 范围：策略仅在加载配置时冻结，非法值拒绝启动；不改变运行中任务或真实部署环境。
test('统一策略默认启用共享计划及收尾能力，并支持显式回退', (t) => {
  configure(t);
  assert.equal(loadConfig().executionPolicy, 'planned-v1');
  assert.equal(loadConfig().executionGuidance, true);
  process.env.PROOFRUN_AGENT_EXECUTION_GUIDANCE = 'false';
  assert.equal(loadConfig().executionGuidance, true);
  process.env.PROOFRUN_AGENT_EXECUTION_POLICY = 'legacy';
  assert.equal(loadConfig().executionPolicy, 'legacy');
  assert.equal(loadConfig().executionGuidance, false);
  process.env.PROOFRUN_AGENT_EXECUTION_POLICY = 'planned-v1';
  assert.equal(loadConfig().executionGuidance, true);
  process.env.PROOFRUN_AGENT_EXECUTION_POLICY = 'unknown';
  assert.throws(() => loadConfig(), /PROOFRUN_AGENT_EXECUTION_POLICY/);
});
