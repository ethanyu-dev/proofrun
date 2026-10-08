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

// 范围：检查实际本地 HTTP 正文及审计存档；模型回复为夹具，不代表真实模型验收。
test('Chat Completions 仅发送显式思考模式且保留强制工具协议', async () => {
  const server = await modelServer(() => ({
    type: 'browser.observe',
    screenshot: false,
  }));
  try {
    for (const thinking of [undefined, 'enabled', 'disabled']) {
      let recorded;
      const model = new ChatModel({
        ...config,
        modelUrl: server.url,
        thinking,
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
      assert.equal(body.tool_choice, 'required');
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
