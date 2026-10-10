import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { execute } from '../../apps/agent/dist/execution/runner.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { ControlClient } from '../../apps/agent/dist/client.js';
import { AgentFault, pause } from '../../apps/agent/dist/http.js';
import { LeaseGuard } from '../../apps/agent/dist/execution/lease.js';
import { Workflow } from '../../apps/agent/dist/execution/workflow.js';
import { config, grant, FakeControl, finish, modelServer } from './fixture.mjs';

/** 每次调用独占一个本地模型 HTTP 端口，保证失败也关闭监听。 */
async function run(decide, prepare = () => {}, overrides = {}) {
  const server = await modelServer(decide);
  const execution = grant();
  const client = new FakeControl();
  const settings = { ...config, modelUrl: server.url, ...overrides };
  await prepare(client, execution);
  try {
    const report = await execute(
      settings,
      client,
      new ChatModel(settings),
      execution,
    );
    assert.deepEqual(server.errors, []);
    return { report, client, requests: server.requests };
  } finally {
    await server.close();
  }
}

// 范围：真实模型 HTTP 协议、逐步刷新、动态观察身份与报告；浏览器和模型推理均为夹具。
test('填写、提交、观察成功文本并生成可追溯报告', async () => {
  const { report, client, requests } = await run(
    (context, turn, body, request) => {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, `Bearer ${config.modelKey}`);
      assert.equal(body.model, config.model);
      assert.equal(body.max_tokens, 512);
      assert.equal(body.parallel_tool_calls, false);
      assert.equal(body.tool_choice, 'required');
      assert.ok(
        body.tools.some((tool) => tool.function.name === 'verification_finish'),
      );
      assert.ok(!JSON.stringify(body.messages).includes(config.workerToken));
      if (turn === 1)
        return {
          type: 'browser.act',
          action: 'fill',
          target: '@e1',
          value: 'Alice',
        };
      if (turn === 2)
        return { type: 'browser.act', action: 'click', target: '@e2' };
      assert.equal(context.observation.text, '已提交 Alice');
      return finish(context);
    },
  );
  assert.equal(report.verdict, 'PASSED');
  assert.equal(report.executionDetails.modelCalls, 3);
  assert.equal(report.executionDetails.actions, 3);
  assert.equal(report.executionDetails.promptTokens, 60);
  assert.equal(client.calls.length, 6);
  assert.equal(client.calls[2].operation.observationId, client.observedIds[0]);
  assert.equal(client.calls[4].operation.observationId, client.observedIds[1]);
  assert.equal(new Set(report.executionDetails.commandIds).size, 6);
  assert.equal(requests.length, 3);
  // 每次保存实际 HTTP 正文，历史上下文不能由最后一轮倒推替代。
  const starts = client.modelCalls.filter(
    (item) => item.body.phase === 'start',
  );
  assert.equal(starts.length, requests.length);
  for (const [index, item] of starts.entries()) {
    assert.deepEqual(JSON.parse(item.body.record.request), requests[index]);
    assert.equal(item.body.record.callIndex, index + 1);
    assert.equal(item.body.record.decisionIndex, index + 1);
    assert.ok(!item.body.record.request.includes(config.modelKey));
    const receipt = client.modelCalls.find(
      (entry) => entry.id === item.id && entry.body.phase === 'finish',
    );
    assert.equal(receipt.body.result.status, 'RECEIVED');
    assert.equal(receipt.body.result.promptTokens, 20);
  }
});

// 范围：请求前存档失败会阻止模型 HTTP 派发；不模拟真实数据库中断或模型账户计费。
test('上下文未存档时不派发模型请求', async () => {
  const { report, requests } = await run(finish, (client) => {
    client.recordModelCall = async () => {
      throw new Error('fixture unavailable');
    };
  });
  assert.equal(requests.length, 0);
  assert.equal(report.executionDetails.reasonCode, 'MODEL_TRACE_UNAVAILABLE');
});

// 范围：目标幻觉与证据幻觉均被本地拒绝并有界修复；不证明真实模型能自行纠正。
test('拒绝虚构目标和证据，修复前不发动作', async () => {
  const { report, client } = await run((context, turn) => {
    if (turn === 1)
      return { type: 'browser.act', action: 'click', target: '@unknown' };
    if (turn === 2) {
      assert.ok(context.feedback);
      const value = finish(context);
      value.criteria[0].evidenceRefs = ['foreign'];
      return value;
    }
    assert.ok(context.feedback);
    return finish(context);
  });
  assert.equal(report.verdict, 'PASSED');
  assert.equal(client.calls.length, 2);
});

// 范围：封闭工具结构、错误次数限制；不模拟某一真实供应商的工具遵从率。
test('连续非法工具调用产生故障报告，不能执行任意脚本', async () => {
  const { report, client } = await run(() => ({
    type: 'browser.eval',
    script: 'untrusted()',
  }));
  assert.equal(report.executionDisposition, 'ERROR');
  assert.equal(report.verdict, null);
  assert.equal(report.executionDetails.reasonCode, 'INVALID_MODEL_DECISION');
  assert.equal(report.executionDetails.modelCalls, 3);
  assert.equal(client.calls.length, 2);
});

// 范围：错误反馈定位实际分支并拒绝额外字段；仅验证纠错协议，不保证真实模型遵从。
test('模型格式反馈指出缺失字段且不回显未知字段内容', async () => {
  const { report, client } = await run((context, turn) => {
    if (turn === 1)
      return { type: 'browser.act', secretField: 'private-value' };
    assert.match(context.feedback, /required property 'action'/);
    assert.match(context.feedback, /additional properties/);
    assert.ok(!context.feedback.includes('secretField'));
    assert.ok(!context.feedback.includes('private-value'));
    return finish(context);
  });
  assert.equal(report.verdict, 'PASSED');
  assert.equal(client.calls.length, 2);
});

// 范围：工具名固定动作类型，参数不能借 type 绕过分支；不测试供应商自身的工具约束实现。
test('拒绝工具参数覆盖工具名对应的动作类型', async () => {
  const { report, client } = await run((context, turn) => {
    if (turn === 1)
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
                      name: 'browser_observe',
                      arguments: JSON.stringify({
                        type: 'browser.act',
                        action: 'click',
                        target: '@e2',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        },
      };
    assert.match(context.feedback, /不接受 type/);
    return finish(context);
  });
  assert.equal(report.verdict, 'PASSED');
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'click').length,
    0,
  );
});

// 范围：跨页面事实及证据关联保留，旧观察目标仍被拒绝；不将夹具视为实际网站验收。
test('切换页面后保留历史正文但不接受旧元素身份', async () => {
  const { report, client } = await run(
    (context, turn) => {
      if (turn === 1)
        return { type: 'browser.act', action: 'click', target: '@e2' };
      assert.equal(context.observation.text, '已提交 ');
      const prior = context.previousObservations[0];
      assert.equal(prior.text, '名称和提交表单');
      assert.equal(prior.truncated, false);
      assert.equal(prior.targets, undefined);
      assert.ok(
        context.evidence.some((e) => e.id === prior.artifactRefs[0].artifactId),
      );
      if (turn === 2)
        return { type: 'browser.act', action: 'click', target: '@e2' };
      assert.match(context.feedback, /目标不属于当前观察/);
      return finish(context);
    },
    (client) => {
      const original = client.command.bind(client);
      client.command = async (...args) => {
        const result = await original(...args);
        if (args[2].type === 'browser.observe' && client.submitted)
          result.data.targets = [
            { target: '@new', role: 'button', name: '新页面' },
          ];
        return result;
      };
    },
  );
  assert.equal(report.verdict, 'PASSED');
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'click').length,
    1,
  );
});

// 范围：历史正文中重复的元素编号会被移除，正文事实仍保留；不模拟真实 DOM 的语义正确性。
test('历史正文移除可复用的元素编号', async () => {
  await run(
    (context, turn) => {
      if (turn === 1) return { type: 'browser.observe' };
      assert.ok(!context.previousObservations[0].text.includes('element-9'));
      assert.ok(!context.previousObservations[0].text.includes('ref=e9'));
      assert.ok(context.previousObservations[0].text.includes('历史价格'));
      return finish(context);
    },
    (client) => {
      client.pageText = '历史价格 [target=element-9] [selected, ref=e9]';
    },
  );
});

// 范围：未知写入从循环退出，不再次调用模型或换身份重放；不证明引擎内部写入次数。
test('未知业务效果结束执行，不重试点击', async () => {
  const { report, client } = await run(
    () => ({ type: 'browser.act', action: 'click', target: '@e2' }),
    (client) => {
      client.unknown = true;
    },
  );
  assert.equal(report.executionDetails.reasonCode, 'BROWSER_EFFECT_UNKNOWN');
  assert.equal(report.verdict, null);
  assert.equal(report.executionDetails.modelCalls, 1);
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'click').length,
    1,
  );
});

// 范围：动作预算包含初始导航，循环轮数独立有界；不评估模型 token 成本的精确计费。
test('动作和模型预算都有硬上限', async () => {
  const action = await run(
    () => ({ type: 'browser.act', action: 'click', target: '@e2' }),
    (_client, execution) => {
      execution.task.budget.maxActions = 1;
    },
  );
  assert.equal(
    action.report.executionDetails.reasonCode,
    'ACTION_BUDGET_EXCEEDED',
  );
  assert.equal(action.client.calls.length, 2);
  const turns = await run(() => ({ type: 'browser.observe' }), undefined, {
    maxTurns: 1,
  });
  assert.equal(
    turns.report.executionDetails.reasonCode,
    'MODEL_TURN_BUDGET_EXCEEDED',
  );
  assert.equal(turns.report.executionDetails.modelCalls, 1);
});

// 范围：视觉能力不足明确阻塞而非降级证据；不测试真实多模态模型。
test('截图验收在纯文本配置下阻塞', async () => {
  const { report, client, requests } = await run(
    () => {
      throw new Error('不应调用模型');
    },
    (_client, execution) => {
      execution.task.acceptanceCriteria[0].evidenceKinds = ['SCREENSHOT'];
    },
  );
  assert.equal(report.executionDisposition, 'BLOCKED');
  assert.equal(report.executionDetails.reasonCode, 'VISION_REQUIRED');
  assert.equal(report.criteria[0].verdict, 'SKIPPED');
  assert.equal(client.calls.length, 0);
  assert.equal(requests.length, 0);
});

// 范围：有界页面上下文保持验收标准完整并标记裁剪；不测试所有模型分词器的 token 限制。
test('长页面被裁剪且不会改写任务标准', async () => {
  const { report } = await run(
    (context, _turn, body) => {
      assert.ok(body.messages[1].content.length <= 4000);
      assert.equal(context.truncated, true);
      assert.equal(
        context.task.acceptanceCriteria[0].expectedResult,
        '出现已提交 Alice',
      );
      return { type: 'verification.block', summary: '需要更多页面上下文' };
    },
    (client) => {
      client.pageText = '大页面'.repeat(10000);
    },
    { maxContextChars: 4000 },
  );
  assert.equal(report.executionDisposition, 'BLOCKED');
});

// 范围：实际执行器裁剪后仍保留页尾相关证据；浏览器和模型为夹具，不证明长站点覆盖率。
test('执行器裁剪保留长页尾部任务证据', async () => {
  const { report } = await run(
    (context) => {
      assert.ok(context.observation.text.includes('页尾 Alice 已提交'));
      assert.equal(context.truncated, true);
      return { type: 'verification.block', summary: '仅验证证据保留' };
    },
    (client) => {
      client.pageText = '导航填充 '.repeat(20000) + '页尾 Alice 已提交';
    },
    { maxContextChars: 4000 },
  );
  assert.equal(report.executionDisposition, 'BLOCKED');
});

// 范围：真实等待期间后台续租不依赖模型返回；不模拟网络分区或跨机器时钟偏差。
test('慢模型调用期间独立续租', async () => {
  const { report, client } = await run(
    async (context) => {
      await pause(250);
      return finish(context);
    },
    (_client, execution) => {
      execution.leaseExpiresAt = new Date(Date.now() + 150).toISOString();
    },
  );
  assert.equal(report.verdict, 'PASSED');
  assert.ok(client.renewals >= 1);
});

// 范围：挂起续租与模型请求被原租约定时器中断；关闭资源仍由控制面负责。
test('续租挂起不能延长旧租约', async () => {
  const { report, client } = await run(
    async (context) => {
      await pause(300);
      return finish(context);
    },
    (client, execution) => {
      client.hangingHeartbeat = true;
      execution.leaseExpiresAt = new Date(Date.now() + 120).toISOString();
    },
  );
  assert.equal(report.executionDetails.reasonCode, 'LEASE_LOST');
  assert.equal(client.calls.length, 2);
  assert.equal(report.verdict, null);
});

// 范围：本地截止时间撤销模型，报告保持故障语义；任务最终生命周期由 API 另行验证。
test('任务截止时间独立于续租和模型时限', async () => {
  const { report } = await run(
    async (context) => {
      await pause(300);
      return finish(context);
    },
    (_client, execution) => {
      execution.taskDeadlineAt = new Date(Date.now() + 100).toISOString();
    },
  );
  assert.equal(report.executionDetails.reasonCode, 'TASK_DEADLINE');
  assert.equal(report.verdict, null);
});

// 范围：模型暂时故障仅重试模型读取，不重放浏览器动作；不模拟真实限流策略。
test('模型网络故障有界重试', async () => {
  const client = new FakeControl();
  let calls = 0;
  const report = await execute(
    config,
    client,
    {
      async decide(input) {
        if (++calls < 3) throw new AgentFault('TRANSPORT_ERROR', '夹具中断');
        return {
          decision: finish(JSON.parse(input.text)),
          promptTokens: 1,
          completionTokens: 1,
        };
      },
    },
    grant(),
  );
  assert.equal(report.verdict, 'PASSED');
  assert.equal(report.executionDetails.modelCalls, 3);
  assert.equal(client.calls.length, 2);
});

// 范围：命令 POST 回执丢失时原样重送，结果身份归属核实；真实节点去重在 Linux 集成中验证。
test('控制面命令重送保持相同身份和内容', async () => {
  const execution = grant();
  const bodies = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    bodies.push(body);
    if (bodies.length === 1) {
      response.writeHead(503).end('{}');
      return;
    }
    const fake = new FakeControl();
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        result: await fake.command(execution, body.commandId, body.command),
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new ControlClient({
      ...config,
      apiUrl: `http://127.0.0.1:${server.address().port}`,
    });
    const result = await client.command(
      execution,
      'stable-command',
      {
        type: 'browser.act',
        action: 'click',
        observationId: 'observation',
        target: '@e2',
      },
      1000,
      new AbortController().signal,
    );
    assert.equal(result.operationStatus, 'SUCCEEDED');
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0], bodies[1]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

// 范围：生成成功报告后遭到明确撤权时改交故障元数据；不覆盖网络结果未知的报告重送。
test('完成与取消竞争时保留故障报告', async () => {
  const client = new FakeControl();
  let attempts = 0;
  client.complete = async (_grant, report) => {
    if (++attempts === 1)
      throw new AgentFault('EXECUTION_ENDED', '任务已经结束', 409);
    client.reports.push(report);
  };
  const report = await execute(
    config,
    client,
    {
      async decide(input) {
        return {
          decision: finish(JSON.parse(input.text)),
          promptTokens: 0,
          completionTokens: 0,
        };
      },
    },
    grant(),
  );
  assert.equal(attempts, 2);
  assert.equal(report.executionDisposition, 'ERROR');
  assert.equal(report.verdict, null);
});

// 范围：撤权先于轮询时只读取一次历史结果，不重新提交；不模拟失去控制面的永久分区。
test('撤权后的最后一次只读查询保留未知写入事实', async () => {
  const execution = grant();
  const controller = new AbortController();
  const methods = [];
  const server = createServer(async (request, response) => {
    methods.push(request.method);
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST') {
      for await (const _chunk of request) {
        /* 请求体仅排空，不驱动夹具业务。 */
      }
      response.end(JSON.stringify({ result: null }));
      setTimeout(
        () => controller.abort(new AgentFault('LEASE_LOST', '控制面撤权')),
        30,
      );
    } else {
      const fake = new FakeControl();
      fake.unknown = true;
      response.end(
        JSON.stringify({
          result: await fake.command(execution, 'stable-command', {
            type: 'browser.act',
            action: 'click',
            target: '@e2',
          }),
        }),
      );
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new ControlClient({
      ...config,
      apiUrl: `http://127.0.0.1:${server.address().port}`,
    });
    const result = await client.command(
      execution,
      'stable-command',
      {
        type: 'browser.act',
        action: 'click',
        observationId: 'observation',
        target: '@e2',
      },
      1000,
      controller.signal,
    );
    assert.equal(result.effect, 'MAY_HAVE_HAPPENED');
    assert.deepEqual(methods, ['POST', 'GET']);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

// 范围：人工介入期间不调用模型，恢复后重新观察；浏览器、人工和模型均由夹具驱动。
test('人工处理后丢弃旧模型决定并刷新观察', async () => {
  const execution = grant();
  execution.task.environment.allowIntervention = true;
  const client = new FakeControl();
  let mode = 'AUTO';
  let revision = 0;
  let turns = 0;
  let acknowledged = 0;
  const originalView = client.view.bind(client);
  client.view = async (grant) => ({
    ...(await originalView(grant)),
    controlMode: mode,
    controlRevision: revision,
    actionCount: mode === 'AUTO' ? 1 : execution.task.budget.maxActions,
  });
  client.acknowledge = async () => {
    acknowledged++;
    mode = 'HUMAN';
    setTimeout(() => {
      client.value = 'Human';
      client.submitted = true;
      mode = 'AUTO';
      revision++;
    }, 30);
  };
  const model = {
    decide: async (input) => {
      turns++;
      if (turns === 1) {
        mode = 'REQUESTED';
        revision++;
        return {
          decision: { type: 'browser.act', action: 'click', target: '@e2' },
          promptTokens: 0,
          completionTokens: 0,
        };
      }
      const context = JSON.parse(input.text);
      assert.match(context.observation.text, /Human/);
      // 模拟升级后服务端剔除人工计数，本地不能保留等待时看到的虚高值。
      assert.equal(
        context.budgetRemaining.actions,
        execution.task.budget.maxActions - 1,
      );
      return {
        decision: finish(context),
        promptTokens: 0,
        completionTokens: 0,
      };
    },
  };
  const report = await execute(config, client, model, execution);
  assert.equal(report.verdict, 'PASSED');
  assert.equal(turns, 2);
  assert.equal(acknowledged, 1);
  assert.equal(
    client.calls.filter((call) => call.operation.action === 'click').length,
    0,
  );
  assert.equal(client.observedIds.length, 2);
});

// 范围：模型可请求人工且受原始任务授权约束；不证明登录恢复的业务有效性。
test('未授权人工介入时返回明确阻塞', async () => {
  const { report } = await run(() => ({
    type: 'verification.intervene',
    reason: '需要人工登录',
  }));
  assert.equal(report.executionDisposition, 'BLOCKED');
  assert.equal(report.executionDetails.reasonCode, 'INTERVENTION_DISABLED');
});

// 范围：人工等待跨过初始时限并在恢复后重新计时；控制面与用户完成动作由夹具模拟。
test('人工等待暂停时钟，恢复后使用控制面的新截止时间', async () => {
  const execution = grant();
  execution.taskDeadlineAt = new Date(Date.now() + 100).toISOString();
  execution.task.environment.allowIntervention = true;
  const client = new FakeControl();
  let mode = 'AUTO',
    revision = 0,
    deadline = execution.taskDeadlineAt,
    turns = 0;
  const originalView = client.view.bind(client);
  client.view = async (grant) => ({
    ...(await originalView(grant)),
    controlMode: mode,
    controlRevision: revision,
    taskDeadlineAt: deadline,
    actionCount: 1,
  });
  client.intervene = async () => {
    mode = 'REQUESTED';
    revision = 1;
  };
  client.acknowledge = async () => {
    mode = 'HUMAN';
    setTimeout(() => {
      mode = 'AUTO';
      revision = 2;
      deadline = new Date(Date.now() + 400).toISOString();
    }, 250);
  };
  const model = {
    decide: async (_input, signal) => {
      turns++;
      if (turns > 1) await pause(2000, signal);
      return {
        decision: { type: 'verification.intervene', reason: '需要登录' },
        promptTokens: 0,
        completionTokens: 0,
      };
    },
  };
  const report = await execute(config, client, model, execution);
  assert.equal(report.executionDisposition, 'ERROR');
  assert.equal(report.executionDetails.reasonCode, 'TASK_DEADLINE');
  assert.equal(turns, 2);
});

// 范围：乱序心跳不能覆盖恢复代次，暂停仍服从租约及撤销信号；不代表四小时真实运行压测。
test('人工时钟忽略旧代次，普通续租不重置二十分钟', async () => {
  const execution = grant();
  const stop = new AbortController();
  const guard = new LeaseGuard(new FakeControl(), execution, stop.signal);
  try {
    guard.syncTiming({ controlMode: 'HUMAN', controlRevision: 1 });
    assert.equal(guard.remaining(), Infinity);
    const taskDeadlineAt = new Date(Date.now() + 20 * 60000).toISOString();
    guard.syncTiming({
      controlMode: 'AUTO',
      controlRevision: 2,
      taskDeadlineAt,
    });
    const remaining = guard.remaining();
    assert.ok(remaining > 20 * 60000 - 1000);
    guard.syncTiming({
      controlMode: 'HUMAN',
      controlRevision: 1,
      taskDeadlineAt: execution.taskDeadlineAt,
    });
    guard.syncTiming({
      controlMode: 'AUTO',
      controlRevision: 2,
      taskDeadlineAt,
    });
    assert.ok(guard.remaining() <= remaining);
    stop.abort(new Error('取消'));
    assert.equal(guard.signal.aborted, true);
  } finally {
    await guard.close();
  }
});

// 范围：暂停状态下独立租约计时仍撤权；心跳挂起由夹具模拟。
test('人工暂停仍终止续租挂起的 worker', async () => {
  const execution = grant();
  execution.leaseExpiresAt = new Date(Date.now() + 100).toISOString();
  const client = new FakeControl();
  client.hangingHeartbeat = true;
  const guard = new LeaseGuard(client, execution, new AbortController().signal);
  try {
    guard.syncTiming({ controlMode: 'HUMAN', controlRevision: 1 });
    await new Promise((resolve) =>
      guard.signal.addEventListener('abort', resolve, { once: true }),
    );
    assert.equal(guard.signal.reason.code, 'LEASE_LOST');
  } finally {
    await guard.close();
  }
});

// 范围：初始导航后的连续控制权切换只刷新观察，不重复导航；不模拟未知写入。
test('初始观察遇到控制权切换不会重放导航', async () => {
  const client = new FakeControl();
  const original = client.command.bind(client);
  let rejected = 0;
  client.command = async (...args) => {
    if (args[2].type === 'browser.observe' && rejected++ < 2)
      throw new AgentFault('CONTROL_CHANGED', '人工切换');
    return original(...args);
  };
  const report = await execute(
    config,
    client,
    {
      decide: async (input) => ({
        decision: finish(JSON.parse(input.text)),
        promptTokens: 0,
        completionTokens: 0,
      }),
    },
    grant(),
  );
  assert.equal(report.verdict, 'PASSED');
  assert.equal(
    client.calls.filter((call) => call.operation.action === 'navigate').length,
    1,
  );
  assert.equal(report.executionDetails.actions, 1);
});

// 范围：完成提交被暂停后又取消时仍生成故障报告；不把传输不确定当作明确拒绝。
test('报告提交遇到人工暂停再取消会交付故障报告', async () => {
  const client = new FakeControl();
  const original = client.view.bind(client);
  let cancelled = false;
  const reports = [];
  client.view = async (...args) => ({
    ...(await original(...args)),
    ...(cancelled ? { taskState: 'CANCELLED' } : {}),
  });
  client.complete = async (_grant, report) => {
    reports.push(report);
    if (reports.length === 1) {
      cancelled = true;
      throw new AgentFault('CONTROL_CHANGED', '人工切换');
    }
  };
  const report = await execute(
    config,
    client,
    {
      decide: async (input) => ({
        decision: finish(JSON.parse(input.text)),
        promptTokens: 0,
        completionTokens: 0,
      }),
    },
    grant(),
  );
  assert.equal(reports.length, 2);
  assert.equal(report.executionDisposition, 'ERROR');
  assert.equal(report.executionDetails.reasonCode, 'EXECUTION_ENDED');
});

// 范围：混合策略每个子请求均受模型总预算约束；不调用真实提供者或浏览器。
test('混合策略子请求不能突破模型调用预算', async () => {
  const client = new FakeControl();
  let secondRequestStarted = false;
  const report = await execute(
    { ...config, maxTurns: 1 },
    client,
    {
      decide: async (input) => {
        input.recordRequest('jev-test');
        input.recordRequest('text-test');
        secondRequestStarted = true;
        return {
          decision: finish(JSON.parse(input.text)),
          promptTokens: 0,
          completionTokens: 0,
        };
      },
    },
    grant(),
  );
  assert.equal(secondRequestStarted, false);
  assert.equal(report.executionDetails.modelCalls, 1);
  assert.equal(report.executionDetails.reasonCode, 'MODEL_BUDGET_EXCEEDED');
  assert.deepEqual(report.executionDetails.modelUsage, [
    { model: 'jev-test', calls: 1, promptTokens: 0, completionTokens: 0 },
  ]);
});

// 范围：JEV 候选契约必须拒绝身份混淆、缺失概率和异常数值；不评估模型语义准确率。
test('JEV 严格校验当前候选和概率', async () => {
  const { jevChoice } = await import('../../apps/agent/dist/model/jev.js');
  const candidates = { a: 'A', b: 'B' };
  assert.equal(
    jevChoice(
      { choice: 'a', confidence: 0.8, probabilities: { a: 0.8, b: 0.2 } },
      candidates,
    ).choice,
    'a',
  );
  for (const answer of [
    { choice: 'old', confidence: 1, probabilities: { a: 1, b: 0 } },
    { choice: 'a', confidence: 1, probabilities: { a: 1 } },
    { choice: 'a', confidence: 1, probabilities: { a: 0.2, b: 0.8 } },
    { choice: 'a', confidence: NaN, probabilities: { a: 1, b: 0 } },
  ])
    assert.throws(() => jevChoice(answer, candidates), {
      code: 'INVALID_MODEL_DECISION',
    });
});

// 范围：确定未派发的遮挡触发新观察与模型规划；不证明真实模型会选对遮挡处理动作。
test('目标遮挡后重新观察规划，不自动重放点击', async () => {
  const { report, client } = await run(
    (context, turn) => {
      if (turn === 1)
        return { type: 'browser.act', action: 'click', target: '@e2' };
      assert.match(context.feedback, /遮挡/);
      assert.equal(context.recentOperations.at(-2).effect, 'NOT_STARTED');
      return finish(context);
    },
    (client) => {
      const original = client.command.bind(client);
      client.command = async (...args) => {
        const result = await original(...args);
        if (args[2].action === 'click')
          return {
            ...result,
            operationStatus: 'REJECTED',
            effect: 'NOT_STARTED',
            error: { code: 'TARGET_OBSCURED', message: 'fixture' },
          };
        return result;
      };
    },
  );
  assert.equal(report.verdict, 'PASSED');
  assert.equal(client.observedIds.length, 2);
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'click').length,
    1,
  );
});

// 范围：反复遮挡达到上限后停止，UNKNOWN 仍由已有测试验证立即退出；无真实网站请求。
test('连续目标遮挡有界退出', async () => {
  const { report, client } = await run(
    () => ({ type: 'browser.act', action: 'click', target: '@e2' }),
    (client) => {
      const original = client.command.bind(client);
      client.command = async (...args) => {
        const result = await original(...args);
        return args[2].action === 'click'
          ? {
              ...result,
              operationStatus: 'REJECTED',
              effect: 'NOT_STARTED',
              error: { code: 'TARGET_OBSCURED', message: 'fixture' },
            }
          : result;
      };
    },
  );
  assert.equal(report.executionDetails.reasonCode, 'BROWSER_TARGET_OBSCURED');
  assert.equal(report.executionDisposition, 'BLOCKED');
  assert.equal(report.verdict, null);
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'click').length,
    3,
  );
});

/** 为 JEV 适配器测试构造实际观察形状；不是浏览器采集结果。 */
function jevInput(id, text = '内容 [target=element-1]', actions = 100) {
  return {
    text: JSON.stringify({
      task: { ...grant().task, objective: '查找 GLM 定价' },
      observation: {
        observationId: id,
        url: 'https://example.test/pricing',
        title: '价格',
        text,
        targets: [{ target: 'element-1', role: 'button', name: '模型栏目' }],
        artifactRefs: [
          { artifactId: `evidence-${id}`, kind: 'DOM', sha256: 'a'.repeat(64) },
        ],
        atomic: false,
      },
      evidence: [],
      previousObservations: [],
      recentOperations: [],
      feedback: null,
      budgetRemaining: { actions },
    }),
  };
}
/** 返回完整概率分布以验证客户端契约；不模拟真实供应商推理质量。 */
function jevAnswer(body, choice = 'SCROLL_DOWN') {
  return {
    answers: {
      next: {
        choice,
        confidence: 1,
        probabilities: Object.fromEntries(
          Object.keys(body.questions.next.criteria).map((k) => [
            k,
            k === choice ? 1 : 0,
          ]),
        ),
      },
    },
    usage: { input_tokens: 3, output_tokens: 2 },
  };
}

// 范围：同一决策内 JEV 候选与填写子请求分别记录实际正文，异常记录稳定错误码；不访问真实供应商。
test('JEV 子请求的上下文与失败回执分别记录', async () => {
  const { JevModel } = await import('../../apps/agent/dist/model/jev.js');
  const input = jevInput('trace');
  const context = JSON.parse(input.text);
  context.observation.targets = [
    { target: 'element-1', role: 'textbox', name: '名称' },
  ];
  input.text = JSON.stringify(context);
  const records = [];
  const bodies = [];
  input.traceRequest = async (record) => {
    const entry = { record, receipt: null };
    records.push(entry);
    return async (result) => {
      entry.receipt = result;
    };
  };
  const model = new JevModel(
    { ...config, thinking: 'disabled' },
    'fixture',
    'jev-test',
    async (_url, _key, _method, body) => {
      bodies.push(body);
      if (body.questions) return jevAnswer(body, 'A1');
      throw new AgentFault('HTTP_ERROR', '夹具原始错误不应存档', 401);
    },
  );
  await assert.rejects(model.decide(input, new AbortController().signal), {
    code: 'HTTP_ERROR',
  });
  assert.deepEqual(
    records.map((entry) => entry.record.purpose),
    ['JEV_SELECTION', 'FIELD_VALUE'],
  );
  records.forEach((entry, index) =>
    assert.deepEqual(
      JSON.parse(entry.record.request),
      JSON.parse(JSON.stringify(bodies[index])),
    ),
  );
  // 思考配置只传给文本模型，不能泄漏到 TypeSafe 候选协议。
  assert.equal(Object.hasOwn(bodies[0], 'thinking'), false);
  assert.deepEqual(bodies[1].thinking, { type: 'disabled' });
  assert.equal(records[0].receipt.status, 'RECEIVED');
  assert.equal(records[0].receipt.promptTokens, 3);
  assert.equal(records[1].receipt.status, 'ERROR');
  assert.equal(records[1].receipt.error, 'HTTP_ERROR');
  assert.equal(records[1].receipt.promptTokens, null);
  assert.equal(records[1].receipt.response, null);
});

// 范围：长正文的尾部业务证据和单一联合候选确实进入请求；不调用真实 JEV。
test('JEV 检索两万字符后的相关正文并限制总请求大小', async () => {
  const { JevModel } = await import('../../apps/agent/dist/model/jev.js');
  const calls = [];
  const model = new JevModel(
    { ...config, maxContextChars: 256000 },
    'fixture',
    'jev-test',
    async (_url, _key, _method, body) => {
      calls.push(body);
      return jevAnswer(body, 'A1');
    },
  );
  const text = '无关正文\n'.repeat(6000) + 'GLM 定价 $1';
  const output = await model.decide(
    jevInput('long', text),
    new AbortController().signal,
  );
  assert.ok(calls[0].state.observation.text.includes('GLM 定价 $1'));
  assert.ok(JSON.stringify(calls[0]).length <= 32000);
  assert.equal(calls[0].state.observation.textTruncated, true);
  assert.deepEqual(Object.keys(calls[0].questions), ['next']);
  assert.equal(output.decision.target, 'element-1');
});

// 范围：变更元素编号不算新页面，停滞转交审查，原证据来源保留；不证明真实模型会正确收尾。
test('JEV 重复正文触发 LLM 纠偏并保留跨页证据', async () => {
  const { JevModel } = await import('../../apps/agent/dist/model/jev.js');
  let jevCalls = 0;
  const reviews = [];
  const reviewer = {
    async decide(input) {
      reviews.push(JSON.parse(input.text));
      return {
        decision: { type: 'browser.observe' },
        promptTokens: 5,
        completionTokens: 2,
      };
    },
  };
  const model = new JevModel(
    { ...config, maxContextChars: 256000 },
    'fixture',
    'jev-test',
    async (_u, _k, _m, body) => {
      jevCalls++;
      return jevAnswer(body);
    },
    reviewer,
  );
  for (let i = 0; i < 3; i++)
    await model.decide(
      jevInput(`repeat-${i}`, `GLM 已读取 [target=element-${i}]`),
      new AbortController().signal,
    );
  assert.equal(jevCalls, 2);
  assert.equal(reviews.length, 1);
  assert.match(reviews[0].feedback, /连续两次/);
  assert.equal(
    reviews[0].previousObservations[0].artifactRefs[0].artifactId,
    'evidence-repeat-2',
  );
  assert.ok(!reviews[0].previousObservations[0].text.includes('[target='));
});

// 范围：低动作预算直接进入审查，仍使用请求计数钩子；不提高预算、不自动判通过。
test('JEV 在动作耗尽前交接验收', async () => {
  const { JevModel } = await import('../../apps/agent/dist/model/jev.js');
  let jevCalls = 0;
  let reviewCalls = 0;
  const model = new JevModel(
    config,
    'fixture',
    'jev-test',
    async () => {
      jevCalls++;
      throw new Error('不应请求');
    },
    {
      async decide(input) {
        reviewCalls++;
        assert.match(JSON.parse(input.text).feedback, /预算/);
        return {
          decision: { type: 'verification.block', summary: '证据不足' },
          promptTokens: 1,
          completionTokens: 1,
        };
      },
    },
  );
  await model.decide(
    jevInput('budget', '已采集', 3),
    new AbortController().signal,
  );
  assert.equal(jevCalls, 0);
  assert.equal(reviewCalls, 1);
});

// 范围：历史片段检索覆盖长页业务位置、保留长度边界；不能证明片段涵盖全页面。
test('JEV 历史长页保留任务相关段落', async () => {
  const { evidenceExcerpt, JevProgress } =
    await import('../../apps/agent/dist/model/jev-progress.js');
  const text =
    '其他模型\n'.repeat(6000) +
    '\nGLM 输入价格 $1 输出价格 $2\n' +
    '无关页尾\n'.repeat(6000);
  const excerpt = evidenceExcerpt(text, '收集 GLM 输入和输出价格');
  assert.ok(excerpt.includes('GLM 输入价格'));
  assert.ok(excerpt.length <= 16000);
  const progress = new JevProgress();
  for (let i = 0; i < 6; i++)
    progress.observe(
      JSON.parse(jevInput('unique-' + i, '页面' + i).text).observation,
      '目标',
    );
  // 持续出现新事实时不再仅按固定轮数调用文本审查。
  assert.equal(progress.reviewReason(90), undefined);
  assert.equal(progress.history().length, 6);
});

// 范围：供应商上下文拒绝明确转交完整证据审查，不扩大浏览器权限；服务与审查输出为夹具。
test('JEV 上下文拒绝转交 LLM，其他 HTTP 错误保持失败', async () => {
  const { JevModel } = await import('../../apps/agent/dist/model/jev.js');
  let reviews = 0;
  const reviewer = {
    async decide(input) {
      reviews++;
      assert.match(JSON.parse(input.text).feedback, /上下文长度/);
      return {
        decision: { type: 'browser.observe' },
        promptTokens: 0,
        completionTokens: 0,
      };
    },
  };
  const model = new JevModel(
    config,
    'fixture',
    'jev-test',
    async () => {
      throw new AgentFault('MODEL_CONTEXT_TOO_LARGE', 'fixture', 400);
    },
    reviewer,
  );
  await model.decide(jevInput('limit'), new AbortController().signal);
  assert.equal(reviews, 1);
  const other = new JevModel(
    config,
    'fixture',
    'jev-test',
    async () => {
      throw new AgentFault('HTTP_ERROR', 'fixture', 401);
    },
    reviewer,
  );
  await assert.rejects(
    other.decide(jevInput('auth'), new AbortController().signal),
    { code: 'HTTP_ERROR' },
  );
  assert.equal(reviews, 1);
});

// 范围：格式失败前已返回的子请求用量仍计入，成功回复不会双计；模型和浏览器均为夹具。
test('混合请求失败后总 token 与分项保持一致', async () => {
  const client = new FakeControl();
  let turn = 0;
  const report = await execute(
    config,
    client,
    {
      async decide(input) {
        input.recordRequest('fixture-jev');
        input.recordUsage('fixture-jev', 10, 2);
        if (++turn === 1)
          throw new AgentFault('INVALID_MODEL_DECISION', 'fixture');
        return {
          decision: finish(JSON.parse(input.text)),
          promptTokens: 10,
          completionTokens: 2,
        };
      },
    },
    grant(),
  );
  assert.equal(report.verdict, 'PASSED');
  assert.equal(report.executionDetails.promptTokens, 20);
  assert.equal(report.executionDetails.completionTokens, 4);
  assert.equal(report.executionDetails.modelUsage[0].promptTokens, 20);
});

// 范围：本地 HTTP 返回已知用量后发生截断、JSON 或 schema 错误，重试后的报告仍包含所有请求；不验证供应商计费。
test('文本模型异常回复与修复请求均计入总 token 和模型分项', async () => {
  const invalid = [
    { finish_reason: 'length', message: { role: 'assistant' } },
    {
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        tool_calls: [
          {
            type: 'function',
            function: { name: 'browser_act', arguments: '{' },
          },
        ],
      },
    },
    {
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        tool_calls: [
          {
            type: 'function',
            function: { name: 'browser_act', arguments: '{}' },
          },
        ],
      },
    },
  ];
  for (const choice of invalid) {
    const { report } = await run((context, turn) =>
      turn === 1
        ? {
            raw: {
              choices: [choice],
              usage: { prompt_tokens: 123, completion_tokens: 45 },
            },
          }
        : finish(context),
    );
    assert.equal(report.executionDetails.modelCalls, 2);
    assert.equal(report.executionDetails.promptTokens, 143);
    assert.equal(report.executionDetails.completionTokens, 55);
    assert.deepEqual(report.executionDetails.modelUsage, [
      {
        model: config.model,
        calls: 2,
        promptTokens: 143,
        completionTokens: 55,
      },
    ]);
  }
});

// 范围：连续非法工具回复导致执行失败时仍保留用量；缺失、负数或非整数用量不推算，不覆盖真实网络中断。
test('失败报告保留文本模型用量且拒绝无效 token 数', async () => {
  const { report } = await run((_context, turn) => ({
    raw: {
      choices: [],
      usage:
        turn === 1
          ? { prompt_tokens: 11, completion_tokens: 7 }
          : { prompt_tokens: -1, completion_tokens: 1.5 },
    },
  }));
  assert.equal(report.executionDisposition, 'ERROR');
  assert.equal(report.executionDetails.modelCalls, 3);
  assert.equal(report.executionDetails.promptTokens, 11);
  assert.equal(report.executionDetails.completionTokens, 7);
  assert.deepEqual(report.executionDetails.modelUsage, [
    { model: config.model, calls: 3, promptTokens: 11, completionTokens: 7 },
  ]);
});

// 范围：执行器在导航前启动 TRACE、等待交付并将真实命令引用纳入报告；浏览器和 traceEvents 为夹具。
test('TRACE 从导航前采集到报告前并等待证据可用', async () => {
  const { report, client } = await run(
    (context) => finish(context),
    (client, execution) => {
      execution.task.acceptanceCriteria[0].evidenceKinds = ['DOM', 'TRACE'];
      const command = client.command.bind(client);
      client.command = async (...args) => {
        const result = await command(...args);
        if (args[2].type === 'browser.trace' && args[2].action === 'stop') {
          const artifact = {
            id: 'fixture-trace',
            kind: 'TRACE',
            sha256: 'b'.repeat(64),
            state: 'AVAILABLE',
          };
          client.artifacts.push(artifact);
          result.data = {
            artifactRefs: [
              {
                artifactId: artifact.id,
                kind: artifact.kind,
                sha256: artifact.sha256,
              },
            ],
          };
        }
        return result;
      };
    },
  );
  assert.equal(client.calls[0].operation.type, 'browser.trace');
  assert.equal(client.calls[0].operation.action, 'start');
  assert.equal(client.calls.at(-1).operation.type, 'browser.trace');
  assert.equal(client.calls.at(-1).operation.action, 'stop');
  assert.equal(report.executionDisposition, 'EXECUTED');
  assert.ok(report.criteria[0].evidenceRefs.includes('fixture-trace'));
  assert.equal(
    report.artifacts.find((a) => a.id === 'fixture-trace').kind,
    'TRACE',
  );
});

// 范围：新动作的目标身份注入与视觉操作的纯文本拒绝；不证明真实 DOM 输入效果。
test('新增元素动作绑定当前观察，纯文本模型不能执行视觉点击', async () => {
  for (const action of ['hover', 'check', 'uncheck', 'select']) {
    const { client, report } = await run((context, turn) =>
      turn === 1
        ? {
            type: 'browser.act',
            action,
            target: '@e1',
            ...(action === 'select' ? { value: 'a' } : {}),
          }
        : finish(context),
    );
    const operation = client.calls.find(
      (c) => c.operation.action === action,
    ).operation;
    assert.ok(operation.observationId);
    assert.equal(report.executionDisposition, 'EXECUTED');
  }
  const { client, report } = await run(() => ({
    type: 'browser.act',
    action: 'visual.click',
    x: 10,
    y: 20,
  }));
  assert.equal(report.executionDisposition, 'ERROR');
  assert.ok(!client.calls.some((c) => c.operation.action === 'visual.click'));
});

// 范围：worker 使用的策略选择覆盖新单组和历史对照定义；不代表真实 JEV/LLM 推理验收。
test('显式执行模式选择模型，历史组标识兼容且未拆分并行拒绝执行', async () => {
  const { executionStrategy } =
    await import('../../apps/agent/dist/model/strategy.js');
  const task = grant().task;
  assert.equal(executionStrategy(task), 'llm');
  assert.equal(executionStrategy({ ...task, executionMode: 'jev' }), 'jev');
  assert.equal(executionStrategy({ ...task, executionMode: 'llm' }), 'llm');
  assert.equal(
    executionStrategy({
      ...task,
      comparison: { id: 'pair', arm: 'jev', sourceTaskId: 'source' },
    }),
    'jev',
  );
  assert.equal(
    executionStrategy({
      ...task,
      executionMode: 'llm',
      comparison: { id: 'pair', arm: 'jev', sourceTaskId: 'source' },
    }),
    'llm',
  );
  assert.throws(
    () => executionStrategy({ ...task, executionMode: 'parallel' }),
    { code: 'UNEXPANDED_PARALLEL_TASK' },
  );
});

import { JevModel } from '../../apps/agent/dist/model/jev.js';
import { ObservationTracker } from '../../apps/agent/dist/evidence/changes.js';
import { candidates } from '../../apps/agent/dist/model/candidates.js';

/** 使用显式比较键模拟采集结果；真实节点身份稳定性另由 Chromium 用例验证。 */
function deltaPage(targets, text = '表单', extra = {}) {
  return {
    observationId: 'current',
    url: 'https://example.test/form',
    title: '表单',
    text,
    targets,
    atomic: false,
    artifactRefs: [],
    ...extra,
  };
}
// 范围：编号更换不能伪造变化，复用节点的文字变化和新增弹层会提前；不证明变化由点击导致。
test('差分使用节点比较键，并将当前变化控件提前', () => {
  const tracker = new ObservationTracker();
  const old = {
    target: 'old',
    comparisonKey: 'node-1',
    role: 'button',
    name: '打开',
  };
  assert.equal(
    tracker.observe(deltaPage([old], '打开 [target=old]')).baseline,
    true,
  );
  const same = { ...old, target: 'new' };
  const unchanged = tracker.observe(deltaPage([same], '打开 [target=new]'));
  assert.deepEqual(unchanged.added, []);
  assert.equal(unchanged.unchangedRounds, 1);
  const changed = deltaPage([
    same,
    {
      target: 'menu',
      comparisonKey: 'node-2',
      role: 'option',
      name: '白名单',
      activeRegion: true,
    },
  ]);
  assert.deepEqual(tracker.observe(changed).added, ['menu']);
  assert.equal(changed.targets[0].target, 'menu');
  const reused = deltaPage([{ ...same, name: '关闭' }], '关闭', {
    truncated: true,
  });
  const result = tracker.observe(reused);
  assert.deepEqual(result.updated, ['new']);
  assert.equal(result.removedCount, null);
});

// 范围：根据采集能力生成填写、选择和容器滚动候选，排除隐藏与禁用项；不模拟浏览器遮挡。
test('候选只提供当前可用能力，变化控件不被普通元素淹没', () => {
  const list = candidates(
    [
      ...Array.from({ length: 300 }, (_, i) => ({
        target: `noise-${i}`,
        role: 'element',
        name: '图标',
      })),
      { target: 'hidden', role: 'button', name: '隐藏', visible: false },
      { target: 'disabled', role: 'button', name: '禁用', disabled: true },
      { target: 'static', role: 'button', name: '普通' },
      {
        target: 'new',
        role: 'combobox',
        name: '白名单',
        change: 'added',
        operations: ['click', 'fill'],
      },
      {
        target: 'select',
        role: 'combobox',
        name: '选项',
        operations: ['select'],
        options: [
          { value: 'a', label: '已有', selected: true },
          { value: 'b', label: '新增' },
          { value: 'c', label: '禁用', disabled: true },
        ],
      },
      {
        target: 'scroll',
        role: 'element',
        name: '选项列表',
        operations: ['scroll'],
        scroll: {
          x: 0,
          y: 0,
          width: 200,
          height: 100,
          scrollWidth: 200,
          scrollHeight: 500,
        },
      },
    ],
    '白名单',
  );
  assert.deepEqual(
    list.map((c) => [c.target, c.operation]),
    [
      ['new', 'CLICK'],
      ['new', 'TYPE_TEXT'],
      ['static', 'CLICK'],
      ['select', 'SELECT'],
      ['scroll', 'SCROLL_DOWN'],
    ],
  );
  assert.equal(list.find((c) => c.operation === 'SELECT').value, 'b');
});

// 范围：通过完整执行循环验证两类模型共用的停滞止损；页面与模型均为夹具，不代表业务成功率。
test('连续无变化的观察在公共执行器有界停止', async () => {
  const { report, requests } = await run(
    () => ({ type: 'browser.observe' }),
    (_client, execution) => {
      execution.task.budget.maxActions = 30;
    },
    { maxTurns: 30 },
  );
  assert.equal(report.executionDisposition, 'BLOCKED');
  assert.equal(report.executionDetails.reasonCode, 'NO_PROGRESS');
  assert.equal(requests.length, 6);
});

// 范围：模拟 JEV HTTP 回包，验证放宽后仍保留截断说明且新增尾部按钮进入候选；不验证供应商质量。
test('JEV 放宽动作数量并显式传递候选缺口', async () => {
  const input = JSON.parse(jevInput('wide').text);
  input.observation.targets = Array.from({ length: 260 }, (_, i) => ({
    target: `button-${i}`,
    role: 'button',
    name: `操作 ${i}`,
    operations: ['click'],
  }));
  input.observation.targets[259].change = 'added';
  let seen;
  const model = new JevModel(
    { ...config, maxContextChars: 64000 },
    'fixture',
    'jev-fixture',
    async (_url, _key, _method, body) => {
      seen = body;
      return jevAnswer(seen, 'A1');
    },
  );
  const output = await model.decide(
    { text: JSON.stringify(input) },
    new AbortController().signal,
  );
  assert.equal(output.decision.target, 'button-259');
  assert.equal(seen.state.candidateCoverage.totalActions, 260);
  assert.ok(seen.state.candidateCoverage.returnedActions > 80);
  assert.ok(seen.state.candidateCoverage.omittedActions > 0);
  assert.ok(Object.keys(seen.questions.next.criteria).length <= 255);
});

// 范围：长差分也受执行器预算约束，并保留当前动作目标；模拟正文更新，不证明实际网页异步等待。
test('长变化正文不会挤掉全部当前控件或突破上下文预算', async () => {
  const { report } = await run(
    (context, turn) => {
      assert.ok(JSON.stringify(context).length <= 4000);
      if (turn === 1)
        return {
          type: 'browser.act',
          action: 'fill',
          target: '@e1',
          value: 'Alice',
        };
      assert.equal(context.changes.textTruncated, true);
      assert.ok(context.observation.targets.length > 0);
      return finish(context);
    },
    (client) => {
      const original = client.command.bind(client);
      client.command = async (...args) => {
        if (args[2].action === 'fill')
          client.pageText = '新增变化内容'.repeat(4000);
        return original(...args);
      };
    },
    { maxContextChars: 4000 },
  );
  assert.equal(report.verdict, 'PASSED');
});

// 范围：JEV 的停滞判断计入控件展开状态，不能仅依赖正文；输入状态为夹具。
test('正文不变但控件展开时 JEV 不误触发停滞纠偏', async () => {
  const { JevProgress } =
    await import('../../apps/agent/dist/model/jev-progress.js');
  const progress = new JevProgress();
  for (let i = 0; i < 3; i++)
    progress.observe(
      {
        ...deltaPage([
          {
            target: 'button',
            role: 'combobox',
            name: '展开',
            expanded: i % 2 === 0,
          },
        ]),
        observationId: `state-${i}`,
      },
      '展开下拉',
    );
  assert.equal(progress.reviewReason(100), undefined);
});

// 范围：原始编号要求、证据归属与更新原子性；不证明模型对证据业务含义的判断正确。
test('通用 workflow 不允许改写要求或用虚构证据跳过步骤', async () => {
  const { Workflow } =
    await import('../../apps/agent/dist/execution/workflow.js');
  const workflow = new Workflow(
    '约束：不得提交\n1. 查看订单列表\n2. 打开详情核对金额\n3. 关闭详情',
  );
  assert.equal(workflow.view().steps.length, 3);
  assert.throws(
    () =>
      workflow.apply(
        {
          assessments: [
            {
              stepId: 'step-1',
              outcome: 'complete',
              summary: '已观察',
              evidenceRefs: ['real'],
            },
            {
              stepId: 'step-2',
              outcome: 'complete',
              summary: '未知',
              evidenceRefs: ['invented'],
            },
          ],
        },
        new Set(['real']),
      ),
    { code: 'INVALID_MODEL_DECISION' },
  );
  assert.equal(workflow.view().steps[0].status, 'pending');
  assert.throws(() => workflow.apply({ steps: [] }, new Set()), {
    code: 'INVALID_MODEL_DECISION',
  });
  workflow.apply(
    {
      assessments: [
        {
          stepId: 'step-1',
          outcome: 'complete',
          summary: '列表已显示',
          evidenceRefs: ['real'],
        },
      ],
    },
    new Set(['real']),
  );
  assert.equal(workflow.view().activeStep, 'step-2');
  assert.throws(() => workflow.assertFinish({ type: 'verification.finish' }), {
    code: 'WORKFLOW_INCOMPLETE',
  });
  assert.equal(workflow.view().steps[2].requirement, '关闭详情');
});

// 范围：恢复计划跨轮保留、有界扣减、人工恢复失效；不执行实际浏览器恢复动作。
test('恢复计划不因观察而清空，成功动作消耗预算', async () => {
  const { Workflow } =
    await import('../../apps/agent/dist/execution/workflow.js');
  const workflow = new Workflow('查找商品价格');
  workflow.apply(
    {
      recovery: {
        goal: '展开筛选',
        scope: '搜索区域',
        terms: ['筛选'],
        successCondition: '筛选选项可见',
        maxActions: 2,
      },
    },
    new Set(),
  );
  assert.equal(workflow.view().recovery.remaining, 2);
  workflow.acted();
  workflow.acted();
  workflow.acted();
  assert.equal(workflow.view().recovery.remaining, 0);
  workflow.invalidateRecovery();
  assert.equal(workflow.view().recovery, null);
  assert.throws(
    () =>
      workflow.apply(
        {
          recovery: {
            goal: '查找',
            scope: '',
            terms: [],
            successCondition: '找到',
            maxActions: 999,
          },
        },
        new Set(),
      ),
    { code: 'INVALID_MODEL_DECISION' },
  );
});

// 范围：真实本地模型 HTTP 与执行器共同阻止部分标准提前结束；页面与证据内容是夹具。
test('LLM 必须记录显式任务各步骤，不能只按唯一 criterion 提前结束', async () => {
  const { report, requests } = await run(
    (context, turn, body) => {
      assert.ok(body.tools[0].function.parameters.properties.workflow);
      if (turn === 1) return finish(context);
      if (turn === 2) {
        assert.match(context.feedback, /未完成步骤/);
        return { type: 'browser.act', action: 'click', target: '@e2' };
      }
      return {
        ...finish(context),
        workflow: {
          assessments: context.workflow.steps.map((s) => ({
            stepId: s.id,
            outcome: 'complete',
            summary: '当前夹具展示已提交状态',
            evidenceRefs: [context.observation.artifactRefs[0].artifactId],
          })),
        },
      };
    },
    (_client, execution) => {
      execution.task.objective = '1. 提交表单\n2. 核对提交结果';
    },
  );
  assert.equal(report.verdict, 'PASSED');
  assert.equal(requests.length, 3);
});

// 范围：步骤相关性与区域排序优先于无关新增控件；未知 portal、全局导航和退出入口仍可恢复。
test('当前阶段优先且不硬删除其他区域候选', async () => {
  const { candidates } =
    await import('../../apps/agent/dist/model/candidates.js');
  const targets = [
    {
      target: 'later',
      role: 'button',
      name: '新增商品',
      change: 'added',
      region: { key: 'main', role: 'main', name: '主区' },
    },
    {
      target: 'search',
      role: 'combobox',
      name: '类型',
      operations: ['click'],
      region: { key: 'search', role: 'form', name: '搜索区域' },
    },
    {
      target: 'dialog',
      role: 'combobox',
      name: '类型',
      operations: ['click'],
      region: { key: 'dialog', role: 'dialog', name: '新增弹窗' },
    },
    { target: 'portal', role: 'option', name: '所有类别' },
    { target: 'close', role: 'button', name: 'Close' },
    { target: 'nav', role: 'link', name: '首页' },
  ];
  const result = candidates(targets, '检查类型', { scope: '搜索区域' });
  assert.equal(result[0].target, 'search');
  assert.equal(
    result.find((c) => c.target === 'dialog').field.region.name,
    '新增弹窗',
  );
  assert.deepEqual(
    new Set(result.map((c) => c.target)),
    new Set(targets.map((t) => t.target)),
  );
});

// 范围：JEV 与 LLM 审查之间传递同一份阶段和恢复元数据；不调用真实模型或推断其选择质量。
test('JEV 审查输出的计划沿用到下一轮并保留完成元数据', async () => {
  const { Workflow } =
    await import('../../apps/agent/dist/execution/workflow.js');
  const workflow = new Workflow('1. 查看目录\n2. 检查详情');
  const update = {
    recovery: {
      goal: '定位目录',
      scope: '目录',
      terms: ['目录'],
      successCondition: '目录可见',
      maxActions: 3,
    },
  };
  let calls = 0;
  const model = new JevModel(
    { ...config, maxContextChars: 64000 },
    'fixture',
    'jev-fixture',
    async (_u, _k, _m, body) => {
      calls++;
      assert.equal(body.state.workflow.activeStep, 'step-1');
      if (calls === 1) return jevAnswer(body, 'REPLAN');
      assert.equal(body.state.workflow.recovery.remaining, 3);
      return jevAnswer(body, 'A1');
    },
    {
      async decide() {
        return {
          decision: { type: 'browser.observe' },
          workflow: update,
          promptTokens: 1,
          completionTokens: 1,
        };
      },
    },
  );
  const input = jevInput('plan');
  let ctx = JSON.parse(input.text);
  ctx.workflow = workflow.view();
  input.text = JSON.stringify(ctx);
  const output = await model.decide(input, new AbortController().signal);
  assert.deepEqual(output.workflow, update);
  workflow.apply(output.workflow, new Set());
  ctx.workflow = workflow.view();
  ctx.observation.observationId = 'plan-2';
  ctx.observation.text = '目录已显示';
  input.text = JSON.stringify(ctx);
  await model.decide(input, new AbortController().signal);
  assert.equal(calls, 2);
});

// 范围：公共执行器识别 ABAB 循环且两种模型端口一致；不将页面变化模拟为真实业务完成。
test('反复开关状态即使每轮有变化也会有界停止', async () => {
  const execution = grant();
  execution.task.budget.maxActions = 30;
  const client = new FakeControl();
  const original = client.command.bind(client);
  let observations = 0;
  client.command = async (...args) => {
    const result = await original(...args);
    if (args[2].type === 'browser.observe')
      result.data.text = ++observations % 2 ? '弹窗关闭' : '弹窗打开';
    return result;
  };
  const report = await execute(
    { ...config, maxTurns: 20 },
    client,
    {
      async decide() {
        return {
          decision: { type: 'browser.act', action: 'click', target: '@e2' },
          promptTokens: 0,
          completionTokens: 0,
        };
      },
    },
    execution,
  );
  assert.equal(report.executionDetails.reasonCode, 'NO_PROGRESS');
  assert.ok(report.executionDetails.modelCalls < 10);
});

// 范围：只有菜单外壳时补观察不产生模型请求；没有真实加载事件，不能证明任意 SPA 在等待上限内就绪。
test('导航外壳补采有界且不把等待算作模型调用', async () => {
  const { report, requests } = await run(finish, (client) => {
    const original = client.command.bind(client);
    let reads = 0;
    client.command = async (...args) => {
      const result = await original(...args);
      if (args[2].type === 'browser.observe' && ++reads === 1)
        result.data.targets = [
          { target: 'nav', role: 'menuitem', name: '导航' },
        ];
      return result;
    };
  });
  assert.equal(report.executionDetails.modelCalls, 1);
  assert.equal(requests.length, 1);
});

// 范围：自由文本保留整体要求，编号步骤延续行不丢失；不自动理解自然语言中的隐含分支。
test('任务拆分保留延续行，简单任务无需单独规划请求', async () => {
  const { Workflow } =
    await import('../../apps/agent/dist/execution/workflow.js');
  const simple = new Workflow('搜索商品并核对价格，必要时翻页');
  assert.equal(simple.view().steps.length, 1);
  simple.assertFinish({ type: 'verification.finish' });
  const multi = new Workflow(
    '1. 检查列表\n   同时记录数量\n2. 查看详情\n   不提交变更',
  );
  assert.match(multi.view().steps[0].requirement, /同时记录数量/);
  assert.match(multi.view().steps[1].requirement, /不提交变更/);
});

// 范围：重复计划不续费、局部计划执行期不触发周期审查、被动观察不清除循环；不测试供应商推理。
test('恢复预算和循环记录不能被重规划或被动等待绕过', async () => {
  const { Workflow } =
    await import('../../apps/agent/dist/execution/workflow.js');
  const { JevProgress } =
    await import('../../apps/agent/dist/model/jev-progress.js');
  const { ObservationTracker } =
    await import('../../apps/agent/dist/evidence/changes.js');
  const workflow = new Workflow('查看详情');
  const recovery = {
    goal: '展开',
    scope: '',
    terms: [],
    successCondition: '详情可见',
    maxActions: 1,
  };
  workflow.apply({ recovery }, new Set());
  workflow.acted();
  workflow.apply({ recovery: { ...recovery, maxActions: 6 } }, new Set());
  assert.equal(workflow.view().recovery.remaining, 0);
  assert.throws(
    () => workflow.assertAction({ type: 'browser.act', action: 'click' }),
    { code: 'WORKFLOW_RECOVERY_EXHAUSTED' },
  );
  const progress = new JevProgress();
  for (let i = 0; i < 3; i++)
    progress.observe(
      JSON.parse(jevInput('cooldown-' + i).text).observation,
      '目标',
    );
  assert.equal(progress.reviewReason(90, true), undefined);
  assert.match(progress.reviewReason(3, true), /预算/);
  const tracker = new ObservationTracker();
  const page = (text) =>
    JSON.parse(jevInput('cycle-' + text, text).text).observation;
  tracker.observe(page('A'));
  tracker.observe(page('B'));
  tracker.observe(page('A'));
  tracker.observe(page('A'), false);
  tracker.reset(true);
  tracker.observe(page('B'));
  assert.equal(tracker.observe(page('A')).repeatedStateVisits, 3);
});

// 范围：允许探索任务调整访问顺序，但未访问的原要求不能被删除；不验证真实页面分支。
test('调整阶段顺序不等于完成或丢弃其余要求', async () => {
  const { Workflow } =
    await import('../../apps/agent/dist/execution/workflow.js');
  const workflow = new Workflow('1. 检查目录\n2. 查看详情');
  workflow.apply({ activeStep: 'step-2' }, new Set());
  assert.equal(workflow.view().steps[0].status, 'pending');
  workflow.apply(
    {
      assessments: [
        {
          stepId: 'step-2',
          outcome: 'complete',
          summary: '详情可见',
          evidenceRefs: ['fact'],
        },
      ],
    },
    new Set(['fact']),
  );
  assert.equal(workflow.view().activeStep, 'step-1');
  assert.throws(() => workflow.assertFinish({ type: 'verification.finish' }), {
    code: 'WORKFLOW_INCOMPLETE',
  });
});

// 范围：阶段证据齐全时直接审查，不额外付一次 JEV 选择；最终业务判定仍由文本模型和执行器承担。
test('JEV 已完成全部阶段时直接进入最终审查', async () => {
  const input = jevInput('all-done');
  const context = JSON.parse(input.text);
  context.workflow = {
    steps: [],
    activeStep: null,
    recovery: null,
    revision: 1,
  };
  input.text = JSON.stringify(context);
  let reviews = 0;
  const model = new JevModel(
    config,
    'fixture',
    'jev-fixture',
    async () => {
      throw new Error('不应再选择动作');
    },
    {
      async decide(i) {
        reviews++;
        assert.match(JSON.parse(i.text).feedback, /全部原始步骤/);
        return {
          decision: { type: 'verification.block', summary: '夹具仅验证路由' },
          promptTokens: 0,
          completionTokens: 0,
        };
      },
    },
  );
  await model.decide(input, new AbortController().signal);
  assert.equal(reviews, 1);
});

// 范围：JEV 选择、本地 HTTP 文本审查、进度元数据和公共完成门槛贯通；所有业务页面和推理选择均为夹具。
test('混合执行端到端保留完成声明且不增加独立规划请求', async () => {
  const server = await modelServer((context) => ({
    ...finish(context),
    workflow: {
      assessments: context.workflow.steps.map((s) => ({
        stepId: s.id,
        outcome: 'complete',
        summary: '提交动作后观察到结果',
        evidenceRefs: [context.observation.artifactRefs[0].artifactId],
      })),
    },
  }));
  const execution = grant();
  execution.task.objective = '1. 提交表单\n2. 核对提交结果';
  const settings = { ...config, modelUrl: server.url, thinking: 'disabled' };
  let selections = 0;
  const model = new JevModel(
    settings,
    'fixture',
    'jev-fixture',
    async (_u, _k, _m, body) => {
      selections++;
      const selected = Object.entries(body.questions.next.criteria).find(
        ([, c]) => c.operation === 'CLICK' && c.field.name === '提交',
      )?.[0];
      return jevAnswer(body, selections === 1 ? selected : 'VERIFY');
    },
  );
  try {
    const report = await execute(settings, new FakeControl(), model, execution);
    assert.equal(report.verdict, 'PASSED');
    assert.equal(report.executionDetails.modelCalls, 3);
    assert.equal(selections, 2);
    assert.equal(server.requests.length, 1);
    assert.deepEqual(server.requests[0].thinking, { type: 'disabled' });
    assert.deepEqual(server.errors, []);
  } finally {
    await server.close();
  }
});

// 范围：区域语义变化影响差分，临时路径变化不算进展；使用同一节点夹具，不验证真实重挂载布局。
test('同名控件移动到不同语义区域时产生变化', () => {
  const tracker = new ObservationTracker();
  const field = {
    target: 'same',
    comparisonKey: 'stable',
    role: 'textbox',
    name: '类型',
    region: { key: 'a', role: 'form', name: '搜索' },
  };
  tracker.observe(deltaPage([field]));
  const moved = {
    ...field,
    region: { key: 'b', role: 'dialog', name: '新增' },
  };
  assert.deepEqual(tracker.observe(deltaPage([moved])).updated, ['same']);
  assert.equal(
    tracker.observe(
      deltaPage([{ ...moved, region: { ...moved.region, key: 'c' } }]),
    ).unchangedRounds,
    1,
  );
});

// 范围：重新进入已完成入口、撤销不充分声明和重新补证；不自动判断自然语言证据的业务含义。
test('步骤可重新进入并降级，重复补证不能清空循环预算', async () => {
  const { Workflow } =
    await import('../../apps/agent/dist/execution/workflow.js');
  const flow = new Workflow('1. 打开弹窗\n2. 检查所有选项\n3. 关闭弹窗');
  const assess = (stepId, outcome) => ({
    stepId,
    outcome,
    summary: '夹具评估',
    evidenceRefs: outcome === 'complete' ? ['real'] : [],
  });
  flow.apply(
    {
      assessments: [
        assess('step-1', 'complete'),
        assess('step-2', 'incomplete'),
      ],
      activeStep: 'step-3',
    },
    new Set(['real']),
  );
  flow.apply({ activeStep: 'step-1' }, new Set());
  assert.equal(flow.view().activeStep, 'step-1');
  flow.apply(
    {
      recovery: {
        goal: '重新打开',
        scope: '详情',
        terms: [],
        successCondition: '弹窗可见',
        maxActions: 1,
      },
    },
    new Set(),
  );
  assert.equal(flow.view().activeStep, 'step-1');
  assert.equal(flow.view().steps[1].status, 'incomplete');
  flow.apply({ assessments: [assess('step-1', 'blocked')] }, new Set());
  assert.equal(flow.view().steps[0].status, 'blocked');
  assert.throws(() => flow.assertFinish({ type: 'verification.finish' }), {
    code: 'WORKFLOW_INCOMPLETE',
  });
  flow.apply(
    { assessments: [assess('step-1', 'complete')] },
    new Set(['real']),
  );
  assert.equal(flow.view().revision, 1);
  assert.equal(flow.view().activeStep, 'step-2');
});

// 范围：部分取证被拒绝后有界交付阻塞报告，不能升级为模型协议错误；页面为夹具。
test('连续提前结束返回 BLOCKED 并保留未完成原因', async () => {
  const { report, requests } = await run(
    (context) => finish(context),
    (_client, execution) => {
      execution.task.objective = '1. 打开弹窗\n2. 检查选项';
    },
  );
  assert.equal(requests.length, 3);
  assert.equal(report.executionDisposition, 'BLOCKED');
  assert.equal(report.verdict, null);
  assert.match(JSON.stringify(report), /WORKFLOW_INCOMPLETE/);
});

// 范围：公共执行器的未完成反馈直接进入 LLM 恢复，不能再让 JEV 选择无关动作；不请求远端模型。
test('JEV 收到工作流恢复反馈时直接交接审查', async () => {
  const { JevModel } = await import('../../apps/agent/dist/model/jev.js');
  let reviews = 0;
  const model = new JevModel(
    config,
    'fixture',
    'jev-test',
    async () => {
      throw new Error('不应请求 JEV');
    },
    {
      async decide(input) {
        reviews++;
        assert.match(JSON.parse(input.text).feedback, /WORKFLOW_INCOMPLETE/);
        return { decision: { type: 'browser.observe' } };
      },
    },
  );
  const input = jevInput('recovery-feedback', '测试页面');
  const context = JSON.parse(input.text);
  context.feedback = 'WORKFLOW_INCOMPLETE: 未完成步骤 step-2';
  await model.decide(
    { ...input, text: JSON.stringify(context) },
    new AbortController().signal,
  );
  assert.equal(reviews, 1);
});

/** 创建已由服务端排序的步骤夹具；只检验执行器，不模拟网页业务成功。 */
function structuredGrant(execution, steps) {
  execution.task.steps = steps.map((step, i) => ({
    stepId: `step-${i + 1}`,
    type: 'verification',
    url: 'http://intranet.test/form',
    exec_order: i + 1,
    description: `步骤 ${i + 1}`,
    policy: [],
    expected: ['可观察结果'],
    ...step,
  }));
  execution.task.acceptanceCriteria = execution.task.steps.flatMap((step) =>
    step.expected.map((expectedResult, i) => ({
      id: `${step.stepId}-expected-${i + 1}`,
      stepId: step.stepId,
      description: step.description,
      expectedResult,
      evidenceKinds: ['DOM'],
    })),
  );
  execution.task.budget.maxActions = 20;
  execution.task.purpose = 'verification';
}

// 范围：独立步骤上下文、同序串行和总预算累计；模型与网页均为脚本夹具。
test('结构化步骤逐个执行并独立保存结果，不向模型暴露后续操作', async () => {
  const seen = [];
  const { report, client } = await run(
    (context) => {
      seen.push(context.executionStep.stepId);
      assert.equal(context.task.steps, undefined);
      assert.deepEqual(
        context.executionStep.policy,
        seen.length === 1 ? ['整数范围 500～10000'] : [],
      );
      return {
        ...finish(context),
        evidenceRefs: context.observation.artifactRefs.map((a) => a.artifactId),
      };
    },
    (client, execution) => {
      structuredGrant(execution, [
        { type: 'setup', expected: [], policy: ['整数范围 500～10000'] },
        { exec_order: 5 },
        { exec_order: 5 },
      ]);
    },
  );
  assert.equal(report.verdict, 'PASSED');
  assert.deepEqual(seen, ['step-1', 'step-2', 'step-3']);
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['COMPLETED', 'COMPLETED', 'COMPLETED'],
  );
  assert.equal(report.criteria.length, 2);
  assert.equal(report.executionDetails.actions, 3);
  assert.equal(report.executionDetails.modelCalls, 3);
  assert.equal(client.reports.length, 1);
  assert(
    client.stepSnapshots.some(
      (s) => s[0].status === 'COMPLETED' && s[1].status === 'PENDING',
    ),
  );
});

// 范围：setup 验收不通过仍尝试后续步骤，保留已知结论和前序异常提示；不将夹具结论视为产品缺陷。
test('setup 失败后继续后续步骤，保留该步验收证据', async () => {
  const { report, client } = await run(
    (context) => {
      const result = finish(context);
      if (context.executionStep.stepId === 'step-1')
        result.criteria[0].verdict = 'FAILED';
      else assert.match(context.task.objective, /前序异常：step-1/);
      return result;
    },
    (_client, execution) => structuredGrant(execution, [{ type: 'setup' }, {}]),
  );
  assert.equal(report.executionDisposition, 'EXECUTED');
  assert.equal(report.verdict, 'FAILED');
  assert.deepEqual(
    report.criteria.map((c) => c.verdict),
    ['FAILED', 'PASSED'],
  );
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['COMPLETED', 'COMPLETED'],
  );
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'navigate').length,
    2,
  );
});

// 范围：后续受阻不覆盖已完成验收；不模拟真实业务异常或供应商判断。
test('后续步骤受阻仍保留前面通过的验收', async () => {
  const { report } = await run(
    (context) =>
      context.executionStep.stepId === 'step-1'
        ? finish(context)
        : { type: 'verification.block', summary: '缺少必要数据' },
    (_client, execution) => structuredGrant(execution, [{}, {}]),
  );
  assert.equal(report.executionDisposition, 'BLOCKED');
  assert.deepEqual(
    report.criteria.map((c) => c.verdict),
    ['PASSED', 'SKIPPED'],
  );
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['COMPLETED', 'BLOCKED'],
  );
});

// 范围：显式短等待不消耗模型调用且随后正常验收；不是一小时等待的真实环境验收。
test('显式等待由执行器计时，不调用模型空转', async () => {
  const start = performance.now();
  const { report } = await run(finish, (_client, execution) =>
    structuredGrant(execution, [
      { type: 'setup', expected: [], wait: { durationMs: 30 } },
      {},
    ]),
  );
  assert.equal(report.verdict, 'PASSED');
  assert.equal(report.executionDetails.modelCalls, 1);
  assert.equal(report.executionDetails.actions, 1);
  assert(performance.now() - start >= 30);
  assert.equal(report.steps[0].evidenceRefs.length, 1);
});

// 范围：等待中终止会停止后续步骤且提交故障事实；不模拟分布式网络分区。
test('显式等待可取消，后续业务操作不会执行', async () => {
  const execution = grant();
  structuredGrant(execution, [
    { type: 'setup', expected: [], wait: { durationMs: 2000 } },
    {},
  ]);
  const client = new FakeControl();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new AgentFault('TASK_CANCELLED', '取消测试')),
    30,
  );
  try {
    const report = await execute(
      config,
      client,
      {
        decide: async () => {
          throw new Error('等待不应调用模型');
        },
      },
      execution,
      controller.signal,
    );
    assert.equal(report.executionDisposition, 'ERROR');
    assert.deepEqual(
      report.steps.map((s) => s.status),
      ['ERROR', 'SKIPPED'],
    );
    assert.equal(client.calls.length, 0);
  } finally {
    clearTimeout(timer);
  }
});

// 范围：setup 没有 expected 仍需本步执行证据；不验证证据的业务含义。
test('setup 空标准不能在没有证据时直接完成', async () => {
  const { report } = await run(finish, (_client, execution) =>
    structuredGrant(execution, [{ type: 'setup', expected: [] }, {}]),
  );
  assert.equal(report.executionDisposition, 'ERROR');
  assert.equal(report.steps[0].status, 'ERROR');
  assert.equal(report.steps[1].status, 'COMPLETED');
});

// 范围：结构化步骤切换重置 JEV 局部停滞，模型总调用仍累计；不调用真实供应商。
test('JEV 按结构化步骤独立检查相同页面，不跨步骤累加停滞', async () => {
  const phases = [];
  const server = await modelServer((context) => {
    phases.push(context.executionStep.stepId);
    assert.equal(context.jevProgress.unchangedObservations, 0);
    return {
      ...finish(context),
      evidenceRefs: context.observation.artifactRefs.map((a) => a.artifactId),
    };
  });
  const execution = grant();
  structuredGrant(execution, [{ type: 'setup', expected: [] }, {}]);
  const settings = { ...config, modelUrl: server.url, maxContextChars: 20000 };
  const model = new JevModel(
    settings,
    'fixture',
    'jev-fixture',
    async (_url, _key, _method, body) => jevAnswer(body, 'VERIFY'),
  );
  try {
    const report = await execute(settings, new FakeControl(), model, execution);
    assert.equal(report.verdict, 'PASSED');
    assert.deepEqual(phases, ['step-1', 'step-2']);
    assert.equal(report.executionDetails.modelCalls, 4);
    assert.deepEqual(server.errors, []);
  } finally {
    await server.close();
  }
});

// 范围：截图与 TRACE 延迟超过浏览器命令预算后仍可交付；浏览器、模型和上传均为夹具。
test('截图和 TRACE 使用独立证据预算，不重发浏览器命令', async (t) => {
  for (const kind of ['SCREENSHOT', 'TRACE']) {
    const { report, client, requests } = await run(
      finish,
      (client, execution) => {
        execution.task.acceptanceCriteria[0].evidenceKinds = ['DOM', kind];
        const command = client.command.bind(client);
        client.image = async () => 'data:image/png;base64,Zml4dHVyZQ==';
        client.command = async (...args) => {
          const result = await command(...args);
          const op = args[2];
          if (
            (kind === 'SCREENSHOT' && op.type === 'browser.observe') ||
            (kind === 'TRACE' &&
              op.type === 'browser.trace' &&
              op.action === 'stop')
          ) {
            const artifact = {
              id: `delayed-${kind}`,
              kind,
              sha256: 'b'.repeat(64),
              state: 'PENDING',
            };
            client.artifacts.push(artifact);
            result.data.artifactRefs ??= [];
            result.data.artifactRefs.push({
              artifactId: artifact.id,
              kind,
              sha256: artifact.sha256,
            });
            const timer = setTimeout(() => {
              artifact.state = 'AVAILABLE';
            }, 300);
            t.after(() => clearTimeout(timer));
          }
          return result;
        };
      },
      { vision: kind === 'SCREENSHOT', commandMs: 100, evidenceMs: 2000 },
    );
    assert.equal(report.executionDisposition, 'EXECUTED');
    assert.ok(report.artifacts.some((a) => a.id === `delayed-${kind}`));
    assert.equal(
      client.calls.filter((c) => c.operation.type === 'browser.observe').length,
      1,
    );
    assert.equal(requests.length, 1);
  }
});

// 范围：截图始终未交付时输出具体诊断并阻止模型；不模拟实际节点断网。
test('证据超时报告保留未就绪状态且不调用模型', async () => {
  const { report, requests } = await run(
    finish,
    (client) => {
      const command = client.command.bind(client);
      client.command = async (...args) => {
        const result = await command(...args);
        if (args[2].type === 'browser.observe') {
          const ref = {
            artifactId: 'pending-screenshot',
            kind: 'SCREENSHOT',
            sha256: 'b'.repeat(64),
          };
          result.data.artifactRefs.push(ref);
          client.artifacts.push({
            id: ref.artifactId,
            ...ref,
            state: 'PENDING',
          });
        }
        return result;
      };
    },
    { vision: true, evidenceMs: 100 },
  );
  assert.equal(report.executionDetails.reasonCode, 'EVIDENCE_UNAVAILABLE');
  assert.match(report.summary, /SCREENSHOT pending-screenshot=PENDING/);
  assert.equal(requests.length, 0);
});

// 范围：独立证据预算不能延长任务或租约；使用短期限和挂起续租夹具，不代表真实集群故障演练。
test('证据等待遵守任务硬期限和租约失效', async () => {
  for (const reason of ['TASK_DEADLINE', 'LEASE_LOST']) {
    const { report, requests } = await run(
      finish,
      (client, execution) => {
        if (reason === 'TASK_DEADLINE')
          execution.taskDeadlineAt = new Date(Date.now() + 100).toISOString();
        else {
          execution.leaseExpiresAt = new Date(Date.now() + 100).toISOString();
          client.hangingHeartbeat = true;
        }
        const command = client.command.bind(client);
        client.command = async (...args) => {
          const result = await command(...args);
          if (args[2].type === 'browser.observe')
            client.artifacts.forEach((artifact) => {
              artifact.state = 'PENDING';
            });
          return result;
        };
      },
      { evidenceMs: 2000 },
    );
    assert.equal(report.executionDetails.reasonCode, reason);
    assert.equal(requests.length, 0);
  }
});

// 范围：请求和回执存档失败保留稳定诊断并停止执行；控制面为夹具，不覆盖真实数据库故障。
test('存档失败报告保留 HTTP 状态与错误码，不泄露底层正文', async () => {
  for (const phase of ['start', 'finish']) {
    const { report, requests } = await run(finish, (client) => {
      const record = client.recordModelCall.bind(client);
      client.recordModelCall = async (...args) => {
        if (args[2].phase === phase)
          throw new AgentFault(
            'INVALID_MODEL_CALL',
            'private-token https://private.invalid',
            400,
          );
        return record(...args);
      };
    });
    assert.equal(report.executionDetails.reasonCode, 'MODEL_TRACE_UNAVAILABLE');
    assert.match(report.summary, /HTTP 400；INVALID_MODEL_CALL/);
    assert.ok(!report.summary.includes('private-token'));
    assert.ok(!report.summary.includes('private.invalid'));
    assert.equal(requests.length, phase === 'start' ? 0 : 1);
  }
});

// 范围：登录要求与可见页面证据的组合，不以导航登录按钮或访客步骤触发；不验证真实账号。
test('登录兜底只匹配当前步骤的登录阻塞', async () => {
  const { needsLoginIntervention } =
    await import('../../apps/agent/dist/execution/login-intervention.js');
  const task = grant().task;
  task.objective = '使用授权测试账号登录后查看邀请页';
  const page = {
    url: 'https://example.com/login',
    targets: [
      { role: 'textbox', name: 'Password', visible: true },
      { role: 'button', name: 'Log in', visible: true },
    ],
  };
  assert.equal(needsLoginIntervention(task, page, 0), true);
  assert.equal(
    needsLoginIntervention(task, { ...page, targets: [page.targets[1]] }, 0),
    false,
  );
  assert.equal(
    needsLoginIntervention(
      task,
      { ...page, targets: page.targets.map((t) => ({ ...t, visible: false })) },
      0,
    ),
    false,
  );
  assert.equal(
    needsLoginIntervention(
      task,
      {
        url: 'https://example.com/referral?redirect=/login',
        targets: [{ role: 'iframe', name: 'Cloudflare security challenge' }],
      },
      0,
    ),
    false,
  );
  assert.equal(
    needsLoginIntervention(
      task,
      {
        ...page,
        targets: [{ role: 'iframe', name: 'Cloudflare security challenge' }],
      },
      0,
    ),
    true,
  );
  task.steps = [{ description: '保持未登录访客状态检查登录按钮', policy: [] }];
  assert.equal(needsLoginIntervention(task, page, 0), false);
  task.steps = [{ description: '查看登录页文案', policy: [] }];
  assert.equal(needsLoginIntervention(task, page, 0), false);
  task.steps = [{ description: 'Verify the sign in form labels', policy: [] }];
  assert.equal(needsLoginIntervention(task, page, 0), false);
});

// 范围：登录表单自动介入和邀请页模型介入均在恢复后重新导航；人工、Cookie 生效和浏览器由夹具模拟。
for (const modelRequested of [false, true])
  test(`登录前置受阻主动 HITL，恢复后继续原任务 ${modelRequested ? 'model' : 'automatic'}`, async () => {
    const execution = grant();
    execution.task.objective = '使用已授权账号登录后验证业务';
    execution.task.environment.allowIntervention = true;
    const client = new FakeControl();
    let mode = 'AUTO',
      revision = 0,
      resumed = false,
      requests = 0,
      turns = 0;
    const originalView = client.view.bind(client),
      originalCommand = client.command.bind(client);
    client.view = async (g) => ({
      ...(await originalView(g)),
      controlMode: mode,
      controlRevision: revision,
      actionCount: 1,
    });
    client.command = async (...args) => {
      const result = await originalCommand(...args);
      if (args[2].type === 'browser.observe' && !resumed) {
        result.data.url = modelRequested
          ? 'https://example.com/referral'
          : 'https://example.com/login';
        result.data.targets = [
          { target: 'password', role: 'textbox', name: '密码' },
          { target: 'login', role: 'button', name: '登录' },
        ];
        if (modelRequested) result.data.targets = result.data.targets.slice(1);
      }
      return result;
    };
    client.intervene = async (_grant, rev, reason, _signal, items) => {
      assert.equal(turns, modelRequested ? 1 : 0);
      assert.equal(rev, 0);
      assert.match(reason, /登录/);
      if (!modelRequested) assert.match(items.join(' '), /Cookie/);
      requests++;
      mode = 'REQUESTED';
      revision++;
    };
    client.acknowledge = async () => {
      mode = 'HUMAN';
      setTimeout(() => {
        resumed = true;
        mode = 'AUTO';
        revision++;
      }, 10);
    };
    const model = {
      decide: async (input) => {
        turns++;
        if (modelRequested && !resumed)
          return {
            decision: { type: 'verification.intervene', reason: '请人工登录' },
            promptTokens: 0,
            completionTokens: 0,
          };
        assert.equal(resumed, true);
        return {
          decision: finish(JSON.parse(input.text)),
          promptTokens: 0,
          completionTokens: 0,
        };
      },
    };
    const report = await execute(config, client, model, execution);
    assert.equal(report.verdict, 'PASSED');
    assert.equal(requests, 1);
    assert.equal(turns, modelRequested ? 2 : 1);
    assert.equal(
      client.calls.filter((c) => c.operation.action === 'navigate').length,
      2,
    );
  });

// 范围：未授权 HITL 的登录前置明确停止，不能自动扩大权限；不连接真实浏览器。
test('登录兜底遵守 allowIntervention 开关', async () => {
  const { report, requests } = await run(finish, (client, execution) => {
    execution.task.objective = '使用授权账号登录后查看业务';
    const command = client.command.bind(client);
    client.command = async (...args) => {
      const result = await command(...args);
      if (args[2].type === 'browser.observe') {
        result.data.url = 'https://example.com/login';
        result.data.targets = [
          { target: 'pwd', role: 'textbox', name: '密码' },
          { target: 'btn', role: 'button', name: '登录' },
        ];
      }
      return result;
    };
  });
  assert.equal(requests.length, 0);
  assert.equal(report.executionDetails.reasonCode, 'INTERVENTION_DISABLED');
});

// 范围：人工未解决登录条件时每步最多自动介入一次，仍可明确受阻；不把人工完成动作当成登录成功。
test('人工返回后仍是登录页，不循环自动请求 HITL', async () => {
  const execution = grant();
  execution.task.objective = '使用授权账号登录后验证业务';
  execution.task.environment.allowIntervention = true;
  const client = new FakeControl();
  let mode = 'AUTO',
    revision = 0,
    requests = 0;
  const view = client.view.bind(client),
    command = client.command.bind(client);
  client.view = async (g) => ({
    ...(await view(g)),
    controlMode: mode,
    controlRevision: revision,
    actionCount: 1,
  });
  client.command = async (...args) => {
    const result = await command(...args);
    if (args[2].type === 'browser.observe') {
      result.data.url = 'https://example.com/login';
      result.data.targets = [
        { target: 'pwd', role: 'textbox', name: '密码' },
        { target: 'btn', role: 'button', name: '登录' },
      ];
    }
    return result;
  };
  client.intervene = async () => {
    requests++;
    mode = 'REQUESTED';
    revision++;
  };
  client.acknowledge = async () => {
    mode = 'HUMAN';
    setTimeout(() => {
      mode = 'AUTO';
      revision++;
    }, 10);
  };
  const model = {
    decide: async () => ({
      decision: { type: 'browser.observe' },
      promptTokens: 0,
      completionTokens: 0,
    }),
  };
  const report = await execute(config, client, model, execution);
  assert.equal(requests, 1);
  assert.equal(report.executionDisposition, 'BLOCKED');
  assert.equal(report.executionDetails.reasonCode, 'NO_PROGRESS');
  assert.equal(report.verdict, null);
});

// 范围：同一次领取完成业务和两步清理，复用执行身份与会话；网页和模型均为夹具。
test('cleanup 在原任务末尾串行执行，只提交一次报告', async () => {
  const seen = [];
  const { report, client } = await run(
    (context) => {
      seen.push(context.executionStep.stepId);
      assert.equal(context.task.cleanupStepIds, undefined);
      return {
        ...finish(context),
        evidenceRefs: context.observation.artifactRefs.map((a) => a.artifactId),
      };
    },
    (_client, execution) => {
      structuredGrant(execution, [
        {},
        { type: 'setup', expected: [] },
        { type: 'setup', expected: [] },
      ]);
      execution.task.cleanupStepIds = ['step-2', 'step-3'];
    },
  );
  assert.deepEqual(seen, ['step-1', 'step-2', 'step-3']);
  assert.deepEqual(
    report.steps.map((step) => step.status),
    ['COMPLETED', 'COMPLETED', 'COMPLETED'],
  );
  assert.equal(report.executionDetails.actions, 3);
  assert.equal(client.reports.length, 1);
});

// 范围：前置失败与模型阻塞均继续后续业务和收尾；不保证真实业务清理幂等。
test('业务失败或阻塞后继续后续业务和清理，保留原结论', async () => {
  for (const mode of ['failed', 'blocked']) {
    const seen = [];
    const { report, client } = await run(
      (context) => {
        seen.push(context.executionStep.stepId);
        if (context.executionStep.stepId === 'step-1') {
          if (mode === 'blocked')
            return { type: 'verification.block', summary: '夹具阻塞' };
          const result = finish(context);
          result.criteria[0].verdict = 'FAILED';
          return result;
        }
        return {
          ...finish(context),
          evidenceRefs: context.observation.artifactRefs.map(
            (a) => a.artifactId,
          ),
        };
      },
      (_client, execution) => {
        structuredGrant(execution, [
          { type: 'setup' },
          {},
          { type: 'setup', expected: [] },
        ]);
        execution.task.cleanupStepIds = ['step-3'];
      },
    );
    assert.deepEqual(seen, ['step-1', 'step-2', 'step-3']);
    assert.equal(
      report.executionDisposition,
      mode === 'failed' ? 'EXECUTED' : 'BLOCKED',
    );
    assert.deepEqual(
      report.steps.map((step) => step.status),
      [mode === 'failed' ? 'COMPLETED' : 'BLOCKED', 'COMPLETED', 'COMPLETED'],
    );
    assert.equal(
      report.criteria[0].verdict,
      mode === 'failed' ? 'FAILED' : 'SKIPPED',
    );
    assert.equal(client.reports.length, 1);
  }
});

// 范围：清理阻塞不会自动重放或执行后续清理，业务证据保留；不验证真实页面失败原因。
test('清理自身阻塞后停止收尾，保留业务验收', async () => {
  const seen = [];
  const { report } = await run(
    (context) => {
      seen.push(context.executionStep.stepId);
      return seen.length === 1
        ? finish(context)
        : { type: 'verification.block', summary: '夹具清理受阻' };
    },
    (_client, execution) => {
      structuredGrant(execution, [
        {},
        { type: 'setup', expected: [] },
        { type: 'setup', expected: [] },
      ]);
      execution.task.cleanupStepIds = ['step-2', 'step-3'];
    },
  );
  assert.deepEqual(seen, ['step-1', 'step-2']);
  assert.deepEqual(
    report.steps.map((step) => step.status),
    ['COMPLETED', 'BLOCKED', 'SKIPPED'],
  );
  assert.equal(report.criteria[0].verdict, 'PASSED');
});

// 范围：撤权后禁止末尾清理动作；使用本地 AbortSignal，不模拟节点断网或真实超时。
test('取消原任务后不会进入 cleanup', async () => {
  const execution = grant();
  structuredGrant(execution, [{}, { type: 'setup', expected: [] }]);
  execution.task.cleanupStepIds = ['step-2'];
  const client = new FakeControl();
  const controller = new AbortController();
  let calls = 0;
  const report = await execute(
    config,
    client,
    {
      decide: async () => {
        calls++;
        controller.abort(new AgentFault('TASK_CANCELLED', '夹具取消'));
        throw controller.signal.reason;
      },
    },
    execution,
    controller.signal,
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    report.steps.map((step) => step.status),
    ['ERROR', 'SKIPPED'],
  );
  assert.equal(
    client.calls.filter((call) => call.operation.action === 'navigate').length,
    1,
  );
});

// 范围：结构化第二步与自定义身份贯通模型 workflow，说明中的编号不再次拆步；不调用真实模型。
test('结构化 workflow 使用当前 stepId，避免第二步被误判非法', async () => {
  const seen = [];
  const { report } = await run(
    (context) => {
      const id = context.executionStep.stepId;
      seen.push(id);
      assert.equal(context.workflow.activeStep, id);
      assert.deepEqual(
        context.workflow.steps.map((s) => s.id),
        [id],
      );
      return {
        ...finish(context),
        workflow: {
          activeStep: id,
          assessments: [
            {
              stepId: id,
              outcome: 'complete',
              summary: '本步已有证据',
              evidenceRefs: context.observation.artifactRefs.map(
                (a) => a.artifactId,
              ),
            },
          ],
        },
      };
    },
    (_client, execution) => {
      structuredGrant(execution, [
        {},
        { description: '1. 检查提示\n2. 检查奖励' },
      ]);
    },
  );
  assert.deepEqual(seen, ['step-1', 'step-2']);
  assert.equal(report.verdict, 'PASSED');
  const workflow = new Workflow('1. 内容\n2. 内容', 'custom-check');
  assert.deepEqual(
    workflow.view().steps.map((s) => s.id),
    ['custom-check'],
  );
});

// 范围：局部模型错误耗尽重试后仍尝试下一业务步骤，保存错误证据和成功项；取消/租约另有测试，不模拟真实供应商故障。
test('一个步骤模型错误不会跳过后续独立业务步骤', async () => {
  const { report, client } = await run(
    (context) =>
      context.executionStep.stepId === 'step-1'
        ? { type: 'browser.act', action: 'click', target: 'not-registered' }
        : finish(context),
    (_client, execution) => structuredGrant(execution, [{}, {}]),
  );
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['ERROR', 'COMPLETED'],
  );
  assert.deepEqual(
    report.criteria.map((c) => c.verdict),
    ['SKIPPED', 'PASSED'],
  );
  assert.equal(report.executionDisposition, 'ERROR');
  assert(report.steps[0].evidenceRefs.length > 0);
  assert.match(report.summary, /业务步骤执行完成 1\/2/);
  assert.match(report.summary, /step-1（ERROR）/);
  assert.equal(client.reports.length, 1);
});

// 范围：控制面签发清理期限后，旧业务心跳和人工暂停不能延长或缩短该期限；缩短时钟夹具不证明真实三分钟运行。
test('清理独立时钟忽略旧心跳，人工暂停不重置预算', async () => {
  const execution = grant();
  execution.taskDeadlineAt = new Date(Date.now() + 100).toISOString();
  const client = new FakeControl();
  client.hangingHeartbeat = true;
  const guard = new LeaseGuard(client, execution, new AbortController().signal);
  try {
    const deadline = new Date(Date.now() + 450).toISOString();
    guard.syncTiming({
      controlMode: 'AUTO',
      controlRevision: 0,
      taskDeadlineAt: deadline,
      cleanupDeadlineAt: deadline,
      leaseExpiresAt: new Date(Date.now() + 3000).toISOString(),
    });
    assert(guard.remaining() > 300);
    assert.equal(
      guard.syncTiming({
        controlMode: 'AUTO',
        controlRevision: 0,
        taskDeadlineAt: execution.taskDeadlineAt,
        cleanupDeadlineAt: null,
        leaseExpiresAt: new Date(Date.now() + 20).toISOString(),
      }),
      false,
    );
    guard.syncTiming({
      controlMode: 'HUMAN',
      controlRevision: 1,
      taskDeadlineAt: new Date(Date.now() + 1200000).toISOString(),
      cleanupDeadlineAt: deadline,
    });
    assert(guard.remaining() <= 450);
    await pause(150);
    assert.equal(guard.signal.aborted, false);
    await new Promise((resolve) =>
      guard.signal.addEventListener('abort', resolve, { once: true }),
    );
    assert.equal(guard.signal.reason.code, 'CLEANUP_DEADLINE_EXCEEDED');
  } finally {
    await guard.close();
  }
});

/** 注入观察结果故障而不生成伪证据；写入结果仍由原夹具记录。 */
function failDomObservations(client, shouldFail) {
  const original = client.command.bind(client);
  client.command = async (...args) => {
    if (args[2].type === 'browser.observe' && shouldFail()) {
      client.calls.push({ id: args[1], operation: args[2] });
      return {
        operationStatus: 'UNKNOWN',
        effect: 'MAY_HAVE_HAPPENED',
        error: { code: 'DOM_ENGINE_FAILED' },
      };
    }
    return original(...args);
  };
}

// 范围：成功点击后的 DOM 读取恢复只补采，不重复点击或消耗模型轮次；不验证真实 CDP 故障。
test('DOM 观察暂时失败只补采两次，不重放已完成点击', async () => {
  let failures = 0;
  const { report, client } = await run(
    (context, turn) =>
      turn === 1
        ? { type: 'browser.act', action: 'click', target: '@e2' }
        : finish(context),
    (client) =>
      failDomObservations(client, () => client.submitted && failures++ < 2),
  );
  assert.equal(report.verdict, 'PASSED');
  assert.equal(report.executionDetails.modelCalls, 2);
  assert.equal(report.executionDetails.actions, 2);
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'click').length,
    1,
  );
  assert.equal(
    client.calls.filter((c) => c.operation.type === 'browser.observe').length,
    4,
  );
  assert.equal(
    new Set(client.calls.map((c) => c.id)).size,
    client.calls.length,
  );
});

// 范围：连续三次读取失败记录本步骤错误，后续业务和清理重新取证；不声称故障页面已经恢复。
test('DOM 观察持续失败有上限，并保留后续独立步骤与清理机会', async () => {
  let reads = 0;
  const seen = [];
  const { report, client } = await run(
    (context) => {
      seen.push(context.executionStep.stepId);
      return {
        ...finish(context),
        evidenceRefs: context.observation.artifactRefs.map((a) => a.artifactId),
      };
    },
    (client, execution) => {
      structuredGrant(execution, [{}, {}, { type: 'setup', expected: [] }]);
      execution.task.cleanupStepIds = ['step-3'];
      failDomObservations(client, () => reads++ < 3);
    },
  );
  assert.deepEqual(seen, ['step-2', 'step-3']);
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['ERROR', 'COMPLETED', 'COMPLETED'],
  );
  assert.equal(report.executionDetails.reasonCode, 'DOM_OBSERVATION_FAILED');
  assert.deepEqual(report.steps[0].evidenceRefs, []);
  assert.equal(
    client.calls.filter((c) => c.operation.type === 'browser.observe').length,
    5,
  );
});

// 范围：重试等待中的控制面撤权阻止下一次观察，不覆盖网络断连或真实人工输入。
test('DOM 补采前重新检查控制权，取消后不再发命令', async () => {
  let failed = false;
  const { report, client } = await run(
    () => {
      throw new Error('不应调用模型');
    },
    (client) => {
      const originalView = client.view.bind(client);
      client.view = async (...args) => ({
        ...(await originalView(...args)),
        taskState: failed ? 'CANCELLED' : 'RUNNING',
      });
      failDomObservations(client, () => {
        failed = true;
        return true;
      });
    },
  );
  assert.equal(report.executionDetails.reasonCode, 'EXECUTION_ENDED');
  assert.equal(
    client.calls.filter((c) => c.operation.type === 'browser.observe').length,
    1,
  );
  assert.equal(report.executionDetails.modelCalls, 0);
});

// 范围：相同 DOM 错误来自点击时仍保留未知写入保护；不模拟浏览器实际副作用。
test('DOM 错误码不能让未知点击进入观察重试', async () => {
  const { report, client } = await run(
    () => ({ type: 'browser.act', action: 'click', target: '@e2' }),
    (client) => {
      client.unknown = true;
      const original = client.command.bind(client);
      client.command = async (...args) => {
        const result = await original(...args);
        if (args[2].action === 'click')
          result.error = { code: 'DOM_ENGINE_FAILED' };
        return result;
      };
    },
  );
  assert.equal(report.executionDetails.reasonCode, 'BROWSER_EFFECT_UNKNOWN');
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'click').length,
    1,
  );
  assert.equal(
    client.calls.filter((c) => c.operation.type === 'browser.observe').length,
    1,
  );
});
