import { compileStepBudget } from '../../contracts/dist/index.js';
import { StepAllowance } from '../../apps/agent/dist/execution/step-budget.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { execute } from '../../apps/agent/dist/execution/runner.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { ControlClient } from '../../apps/agent/dist/client.js';
import { AgentFault, pause } from '../../apps/agent/dist/http.js';
import { LeaseGuard } from '../../apps/agent/dist/execution/lease.js';
import { Workflow } from '../../apps/agent/dist/execution/workflow.js';
import { keyboardReceipt } from '../../apps/agent/dist/execution/keyboard-receipt.js';
import { OperationJournal } from '../../apps/agent/dist/execution/operation-journal.js';
import { config, grant, FakeControl, finish, modelServer } from './fixture.mjs';

// 范围：真实租约定时器抵抗同代次旧快照回退，并拒绝过期后复活；控制面和网络由挂起夹具替代。
test('新续期后到达的旧状态快照不能缩短租约，真正到期仍撤权', async () => {
  const execution = grant();
  execution.leaseExpiresAt = new Date(Date.now() + 150).toISOString();
  const client = new FakeControl();
  client.hangingHeartbeat = true;
  const guard = new LeaseGuard(client, execution, new AbortController().signal);
  try {
    const newer = new Date(Date.now() + 500).toISOString();
    assert.equal(guard.syncTiming({ leaseExpiresAt: newer }), true);
    await pause(200);
    guard.syncTiming({ leaseExpiresAt: execution.leaseExpiresAt });
    assert.equal(guard.signal.aborted, false);
    await pause(350);
    assert.equal(guard.signal.aborted, true);
    assert.equal(
      guard.syncTiming({
        leaseExpiresAt: new Date(Date.now() + 3000).toISOString(),
      }),
      false,
    );
  } finally {
    await guard.close();
  }
});

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

// 范围：真实 Agent 派发和上下文投影，节点聚焦由回执夹具模拟；真实按键另由本地 Chrome 场景覆盖。
test('定向 press 绑定当前观察，并区分请求目标与节点确认焦点', async () => {
  const { client, report } = await run(
    (context, turn, body) => {
      if (turn === 1) {
        const schema = body.tools.find(
          (tool) => tool.function.name === 'browser_act',
        ).function.parameters;
        const pressRule = schema.allOf.find(
          (rule) => rule.if.properties.action.const === 'press',
        );
        assert.deepEqual(
          pressRule.then.properties.target.enum,
          context.page.targets.map((target) => target.target),
        );
        return {
          type: 'browser.act',
          action: 'press',
          target: '@e1',
          value: 'Tab',
        };
      }
      const press = context.history.commands.find(
        (op) => op.action === 'press',
      );
      assert.equal(press.requestedTargetName, '名称');
      assert.equal(press.targetName, '名称');
      assert.deepEqual(press.keyboard, {
        scope: 'target',
        focusVerified: true,
      });
      assert.deepEqual(
        context.history.commands.find((op) => op.action === 'press').keyboard,
        press.keyboard,
      );
      return finish(context);
    },
    (client) => {
      const command = client.command.bind(client);
      client.command = async (...args) => {
        const result = await command(...args);
        if (args[2].type === 'browser.observe')
          result.data.viewport = { targetedPress: true };
        if (args[2].action === 'press')
          result.data.keyboard = {
            scope: 'target',
            target: args[2].target,
            focusVerified: true,
          };
        return result;
      };
    },
  );
  assert.equal(report.verdict, 'PASSED');
  assert.equal(
    client.calls.find((c) => c.operation.action === 'press').operation
      .observationId,
    client.observedIds[0],
  );
});

// 范围：旧节点能力与过期目标在派发前拒绝；不证明模型会主动选择 click 后再 press。
test('旧节点与虚构目标不能静默执行定向 press，全局按键保持可用', async () => {
  for (const supported of [false, true]) {
    const { client } = await run(
      (context, turn, body) => {
        if (turn === 1) {
          if (!supported) {
            const schema = body.tools.find(
              (tool) => tool.function.name === 'browser_act',
            ).function.parameters;
            assert.deepEqual(
              schema.allOf.find(
                (rule) => rule.if.properties.action.const === 'press',
              ).then,
              { not: { required: ['target'] } },
            );
          }
          return {
            type: 'browser.act',
            action: 'press',
            target: supported ? '@stale' : '@e1',
            value: 'Tab',
          };
        }
        if (turn === 2) {
          assert.match(
            context.feedback.map((item) => item.message ?? item.code).join(' '),
            supported ? /目标不属于当前观察/ : /不支持定向 press/,
          );
          return { type: 'browser.act', action: 'press', value: 'Escape' };
        }
        const press = context.history.commands.find(
          (op) => op.action === 'press',
        );
        assert.equal(press.targetName, undefined);
        assert.deepEqual(press.keyboard, {
          scope: 'current-focus',
          focusVerified: false,
        });
        return finish(context);
      },
      (client) => {
        const command = client.command.bind(client);
        client.command = async (...args) => {
          const result = await command(...args);
          if (supported && args[2].type === 'browser.observe')
            result.data.viewport = { targetedPress: true };
          return result;
        };
      },
    );
    const presses = client.calls.filter((c) => c.operation.action === 'press');
    assert.equal(presses.length, 1);
    assert.equal(presses[0].operation.target, undefined);
  }
});

// 范围：旧回执、错误目标和未确认执行不能伪造焦点证据，关键历史保留限制；不执行浏览器。
test('无可靠节点确认时按键目标只保留为请求意图', () => {
  for (const result of [
    { operationStatus: 'SUCCEEDED', effect: 'COMPLETED', data: {} },
    {
      operationStatus: 'SUCCEEDED',
      effect: 'COMPLETED',
      data: {
        keyboard: { scope: 'target', target: '@other', focusVerified: true },
      },
    },
    {
      operationStatus: 'UNKNOWN',
      effect: 'MAY_HAVE_HAPPENED',
      data: {
        keyboard: { scope: 'target', target: '@e1', focusVerified: true },
      },
    },
  ]) {
    const receipt = keyboardReceipt('@e1', '邀请码', result);
    assert.equal(receipt.targetName, undefined);
    assert.equal(receipt.requestedTargetName, '邀请码');
    assert.deepEqual(receipt.keyboard, {
      scope: 'unknown',
      focusVerified: false,
    });
    const journal = new OperationJournal();
    journal.record({
      commandId: 'press',
      operation: 'browser.act',
      action: 'press',
      ...receipt,
      operationStatus: result.operationStatus,
      effect: result.effect,
    });
    for (let i = 0; i < 10; i++)
      journal.record({
        commandId: `observe-${i}`,
        operation: 'browser.observe',
        operationStatus: 'SUCCEEDED',
        effect: 'COMPLETED',
      });
    assert.deepEqual(journal.critical().items[0].keyboard, receipt.keyboard);
    assert.equal(journal.critical().items[0].targetName, undefined);
  }
});

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
      assert.equal(context.page.text, '已提交 Alice');
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
      assert.ok(
        context.feedback.map((item) => item.message ?? item.code).join(' '),
      );
      const value = finish(context);
      value.progress.criteria[0].evidenceRefs = ['foreign'];
      return value;
    }
    assert.ok(
      context.feedback.map((item) => item.message ?? item.code).join(' '),
    );
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
    assert.match(
      context.feedback.map((item) => item.message ?? item.code).join(' '),
      /required property 'action'/,
    );
    assert.match(
      context.feedback.map((item) => item.message ?? item.code).join(' '),
      /additional properties/,
    );
    assert.ok(
      !context.feedback
        .map((item) => item.message ?? item.code)
        .join(' ')
        .includes('secretField'),
    );
    assert.ok(
      !context.feedback
        .map((item) => item.message ?? item.code)
        .join(' ')
        .includes('private-value'),
    );
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
    assert.match(
      context.feedback.map((item) => item.message ?? item.code).join(' '),
      /不接受 type/,
    );
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
      assert.equal(context.page.text, '已提交 ');
      const prior = context.history.excerpts[0];
      assert.equal(prior.text, '名称和提交表单');
      assert.equal(prior.truncated, false);
      assert.equal(prior.targets, undefined);
      assert.ok(
        context.evidence.some((e) => e.id === prior.artifactRefs[0].artifactId),
      );
      if (turn === 2)
        return { type: 'browser.act', action: 'click', target: '@e2' };
      assert.match(
        context.feedback.map((item) => item.message ?? item.code).join(' '),
        /目标不属于当前观察/,
      );
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
      assert.ok(!context.history.excerpts[0].text.includes('element-9'));
      assert.ok(!context.history.excerpts[0].text.includes('ref=e9'));
      assert.ok(context.history.excerpts[0].text.includes('历史价格'));
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
      assert.equal(context.page.coverage.text.truncated, true);
      assert.equal(context.task.criteria[0].expectedResult, '出现已提交 Alice');
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
      assert.ok(context.page.text.includes('页尾 Alice 已提交'));
      assert.equal(context.page.coverage.text.truncated, true);
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
      assert.match(context.page.text, /Human/);
      // 模拟升级后服务端剔除人工计数，本地不能保留等待时看到的虚高值。
      assert.equal(
        context.budget.actions,
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

// 范围：适配器每次请求均受模型总预算约束；不调用真实提供者或浏览器。
test('适配器重复请求不能突破模型调用预算', async () => {
  const client = new FakeControl();
  let secondRequestStarted = false;
  const report = await execute(
    { ...config, maxTurns: 1 },
    client,
    {
      decide: async (input) => {
        input.recordRequest('fixture-model');
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
    { model: 'fixture-model', calls: 1, promptTokens: 0, completionTokens: 0 },
  ]);
});

// 范围：确定未派发的遮挡触发新观察与模型规划；不证明真实模型会选对遮挡处理动作。
test('目标遮挡后重新观察规划，不自动重放点击', async () => {
  const { report, client } = await run(
    (context, turn) => {
      if (turn === 1)
        return { type: 'browser.act', action: 'click', target: '@e2' };
      assert.match(
        context.feedback.map((item) => item.message ?? item.code).join(' '),
        /遮挡/,
      );
      assert.equal(context.history.commands.at(-2).effect, 'NOT_STARTED');
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
    1,
  );
});

// 范围：格式失败前已返回的子请求用量仍计入，成功回复不会双计；模型和浏览器均为夹具。
test('协议失败后总 token 与分项保持一致', async () => {
  const client = new FakeControl();
  let turn = 0;
  const report = await execute(
    config,
    client,
    {
      async decide(input) {
        input.recordRequest('fixture-model');
        input.recordUsage('fixture-model', 10, 2);
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

// 范围：所有执行入口只允许 LLM，历史模式明确拒绝；不调用实际模型。
test('显式旧模式与历史对照均不能进入新执行', async () => {
  const { executionStrategy } =
    await import('../../apps/agent/dist/model/strategy.js');
  const task = grant().task;
  assert.equal(executionStrategy(task), 'llm');
  assert.equal(executionStrategy({ ...task, executionMode: 'llm' }), 'llm');
  for (const mode of ['jev', 'parallel'])
    assert.throws(() => executionStrategy({ ...task, executionMode: mode }), {
      code: 'EXECUTION_MODE_RETIRED',
    });
  assert.throws(
    () =>
      executionStrategy({
        ...task,
        comparison: { id: 'old', arm: 'llm', sourceTaskId: 'source' },
      }),
    { code: 'EXECUTION_MODE_RETIRED' },
  );
});
import { ObservationTracker } from '../../apps/agent/dist/evidence/changes.js';

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
  tracker.observe(deltaPage([old], '打开 [target=old]'));
  assert.equal(old.change, undefined);
  const same = { ...old, target: 'new' };
  const unchanged = tracker.observe(deltaPage([same], '打开 [target=new]'));
  assert.equal(same.change, undefined);
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
  tracker.observe(changed);
  assert.equal(changed.targets[0].change, 'added');
  assert.equal(changed.targets[0].target, 'menu');
  const reused = deltaPage([{ ...same, name: '关闭' }], '关闭', {
    truncated: true,
  });
  tracker.observe(reused);
  assert.equal(reused.targets[0].change, 'updated');
});

// 范围：通过完整执行循环验证两类模型共用的停滞止损；页面与模型均为夹具，不代表业务成功率。
test('连续无变化的观察在公共执行器有界停止', async () => {
  const { report, requests } = await run(
    (context, turn, body) => {
      if (turn >= 3)
        assert(!body.tools.some((t) => t.function.name === 'browser_observe'));
      if (turn >= 4)
        assert.match(
          context.feedback.map((item) => item.message ?? item.code).join(' '),
          /连续观察没有新增事实/,
        );
      return { type: 'browser.observe' };
    },
    (_client, execution) => {
      execution.task.budget.maxActions = 30;
    },
    { maxTurns: 30 },
  );
  assert.equal(report.executionDisposition, 'BLOCKED');
  assert.equal(report.executionDetails.reasonCode, 'NO_PROGRESS');
  assert.equal(requests.length, 5);
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
          requirements: [
            {
              id: 'step-1',
              status: 'complete',
              summary: '已观察',
              evidenceRefs: ['real'],
            },
            {
              id: 'step-2',
              status: 'complete',
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
      requirements: [
        {
          id: 'step-1',
          status: 'complete',
          summary: '列表已显示',
          evidenceRefs: ['real'],
        },
      ],
    },
    new Set(['real']),
  );
  assert.equal(workflow.view().steps[1].status, 'pending');
  assert.throws(() => workflow.assertFinish({ type: 'verification.finish' }), {
    code: 'WORKFLOW_INCOMPLETE',
  });
  assert.equal(workflow.view().steps[2].requirement, '关闭详情');
});

// 范围：真实本地模型 HTTP 与执行器共同阻止部分标准提前结束；页面与证据内容是夹具。
test('LLM 必须记录显式任务各步骤，不能只按唯一 criterion 提前结束', async () => {
  const { report, requests } = await run(
    (context, turn, body) => {
      assert.ok(body.tools[0].function.parameters.properties.progress);
      if (turn === 1) return finish(context);
      if (turn === 2) {
        assert.match(
          context.feedback.map((item) => item.message ?? item.code).join(' '),
          /未完成步骤/,
        );
        return { type: 'browser.act', action: 'click', target: '@e2' };
      }
      return {
        ...finish(context),
        workflow: {
          assessments: context.state.requirements.map((s) => ({
            stepId: s.id,
            outcome: 'complete',
            summary: '当前夹具展示已提交状态',
            evidenceRefs: [context.page.artifactRefs[0].artifactId],
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
  tracker.observe(deltaPage([moved]));
  assert.equal(moved.change, 'updated');
  assert.equal(
    tracker.observe(
      deltaPage([{ ...moved, region: { ...moved.region, key: 'c' } }]),
    ).unchangedRounds,
    1,
  );
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
      seen.push(context.task.stepId);
      assert.equal(context.task.steps, undefined);
      assert.deepEqual(
        context.task.policy,
        seen.length === 1 ? ['整数范围 500～10000'] : [],
      );
      return {
        ...finish(context),
        evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
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
  assert.equal(report.executionDetails.actions, 1);
  assert.equal(report.executionDetails.modelCalls, 3);
  assert.equal(client.reports.length, 1);
  assert(
    client.stepSnapshots.some(
      (s) => s[0].status === 'COMPLETED' && s[1].status === 'PENDING',
    ),
  );
});

// 范围：准备失败归为环境不符合，禁止后续业务并不产生产品失败结论；模型和网页均为夹具。
test('setup 验收不通过时拦截后续业务', async () => {
  const { report, client } = await run(
    (context) => {
      assert.equal(context.task.stepId, 'step-1');
      const result = finish(context);
      result.progress.criteria[0].verdict = 'FAILED';
      return result;
    },
    (_client, execution) => structuredGrant(execution, [{ type: 'setup' }, {}]),
  );
  assert.equal(report.executionDisposition, 'BLOCKED');
  assert.equal(report.executionDetails.reasonCode, 'ENVIRONMENT_NOT_READY');
  assert.deepEqual(
    report.criteria.map((c) => c.verdict),
    ['SKIPPED', 'SKIPPED'],
  );
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['BLOCKED', 'SKIPPED'],
  );
  assert.equal(report.steps[1].startedAt, null);
  assert.equal(
    client.calls.filter((c) => c.operation.action === 'navigate').length,
    1,
  );
});

// 范围：后续受阻不覆盖已完成验收；不模拟真实业务异常或供应商判断。
test('后续步骤受阻仍保留前面通过的验收', async () => {
  const { report } = await run(
    (context) =>
      context.task.stepId === 'step-1'
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

// 范围：显式等待只计时一次，随后仍核实准备条件；不证明真实环境的就绪时机。
test('显式等待后仍须通过准备门禁', async () => {
  const start = performance.now();
  const { report } = await run(finish, (_client, execution) =>
    structuredGrant(execution, [
      { type: 'setup', expected: [], wait: { durationMs: 30 } },
      {},
    ]),
  );
  assert.equal(report.verdict, 'PASSED');
  assert.equal(report.executionDetails.modelCalls, 2);
  assert.equal(report.executionDetails.actions, 0);
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
  const { report } = await run(
    (context) => {
      const result = finish(context);
      delete result.evidenceRefs;
      return result;
    },
    (_client, execution) =>
      structuredGrant(execution, [{ type: 'setup', expected: [] }, {}]),
  );
  assert.equal(report.executionDisposition, 'ERROR');
  assert.equal(report.steps[0].status, 'ERROR');
  assert.equal(report.steps[1].status, 'SKIPPED');
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

// 范围：自动及模型请求的登录介入均直接接管人工页面；人工、Cookie 生效和浏览器由夹具模拟。
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
      1,
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
      seen.push(context.task.stepId);
      assert.equal(context.task.cleanupStepIds, undefined);
      return {
        ...finish(context),
        evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
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
  assert.equal(report.executionDetails.actions, 1);
  assert.equal(client.reports.length, 1);
});

// 范围：业务验收失败与模型阻塞均继续独立业务和收尾；不保证真实业务清理幂等。
test('业务失败或阻塞后继续后续业务和清理，保留原结论', async () => {
  for (const mode of ['failed', 'blocked']) {
    const seen = [];
    const { report, client } = await run(
      (context) => {
        seen.push(context.task.stepId);
        if (context.task.stepId === 'step-1') {
          if (mode === 'blocked')
            return { type: 'verification.block', summary: '夹具阻塞' };
          const result = finish(context);
          result.progress.criteria[0].verdict = 'FAILED';
          return result;
        }
        return {
          ...finish(context),
          evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
        };
      },
      (_client, execution) => {
        structuredGrant(execution, [{}, {}, { type: 'setup', expected: [] }]);
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

// 范围：单个清理受阻后继续后续清理并保留业务结论；不验证真实页面失败原因。
test('清理自身阻塞后继续后续清理，保留业务验收', async () => {
  const seen = [];
  const { report } = await run(
    (context) => {
      seen.push(context.task.stepId);
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
  assert.deepEqual(seen, ['step-1', 'step-2', 'step-3']);
  assert.deepEqual(
    report.steps.map((step) => step.status),
    ['COMPLETED', 'BLOCKED', 'BLOCKED'],
  );
  assert.equal(report.criteria[0].verdict, 'PASSED');
  assert.equal(report.executionDisposition, 'EXECUTED');
  assert.equal(report.verdict, 'PASSED');
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

// 范围：局部模型错误耗尽重试后仍尝试下一业务步骤，保存错误证据和成功项；取消/租约另有测试，不模拟真实供应商故障。
test('一个步骤模型错误不会跳过后续独立业务步骤', async () => {
  const { report, client } = await run(
    (context) =>
      context.task.stepId === 'step-1'
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
      seen.push(context.task.stepId);
      return {
        ...finish(context),
        evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
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

// 范围：脚本模型经真实 HTTP 配合控制面夹具，验证三类耗尽不传播到下一步及清理；不证明真实模型质量或网页验收通过。
for (const kind of ['model', 'action', 'time']) {
  test(`逐步预算：${kind} 耗尽后后续步骤和清理仍可执行`, async () => {
    const seen = [];
    const { report, client } = await run(
      async (context) => {
        const id = context.task.stepId;
        seen.push(id);
        if (id === 'step-1') {
          if (kind === 'time') await pause(300);
          return {
            type: 'browser.act',
            action: 'fill',
            target: '@e1',
            value: 'Alice',
          };
        }
        // 验证步有收尾额度，清理仍使用独立的原始十次动作上限。
        assert.equal(context.budget.modelCalls, id === 'step-2' ? 24 : 20);
        assert.equal(context.budget.actions, id === 'step-2' ? 12 : 10);
        return {
          ...finish(context),
          evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
        };
      },
      (_client, execution) => {
        structuredGrant(execution, [{}, {}, { type: 'setup', expected: [] }]);
        execution.task.cleanupStepIds = ['step-3'];
        execution.task.stepBudget = compileStepBudget(execution.task);
        const first = execution.task.stepBudget.steps[0];
        if (kind === 'model') first.maxModelCalls = 1;
        if (kind === 'action') first.maxActions = 1;
        if (kind === 'time') first.timeoutMs = 200;
        // 旧全局额度故意小于总需求，证明新版不再被全局动作或 maxTurns 卡住。
        execution.task.budget.maxActions = 1;
      },
      { maxTurns: 1 },
    );
    assert.deepEqual(
      report.steps.map((s) => s.status),
      ['BLOCKED', 'COMPLETED', 'COMPLETED'],
    );
    assert.equal(
      report.steps[0].reasonCode,
      kind === 'model'
        ? 'EVIDENCE_INCOMPLETE'
        : `STEP_${{ action: 'ACTION', time: 'TIME' }[kind]}_BUDGET_EXCEEDED`,
    );
    assert.equal(report.steps[0].budgetUsage.modelCalls, 1);
    assert.equal(report.steps[1].budgetUsage.modelCalls, 1);
    assert.equal(report.steps[2].budgetUsage.actions, 0);
    assert.deepEqual(seen, ['step-1', 'step-2', 'step-3']);
    assert.equal(client.reports.length, 1);
    assert.equal(report.criteria[0].verdict, 'SKIPPED');
    assert.equal(report.criteria[1].verdict, 'PASSED');
  });
}

// 范围：多条清理共享一份额度，耗尽不改变已完成业务判定；不验证真实清理副作用。
test('整段清理共享独立模型预算，不能每条清理重新充值', async () => {
  const { report } = await run(
    (context) => ({
      ...finish(context),
      evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
    }),
    (_client, execution) => {
      structuredGrant(execution, [
        {},
        { type: 'setup', expected: [] },
        { type: 'setup', expected: [] },
      ]);
      execution.task.cleanupStepIds = ['step-2', 'step-3'];
      execution.task.stepBudget = compileStepBudget(execution.task);
      execution.task.stepBudget.cleanup.maxModelCalls = 1;
    },
  );
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['COMPLETED', 'COMPLETED', 'BLOCKED'],
  );
  assert.equal(report.steps[2].reasonCode, 'STEP_MODEL_BUDGET_EXCEEDED');
  assert.equal(report.steps[2].budgetUsage.modelCalls, 0);
  assert.equal(report.verdict, 'PASSED');
});

// 范围：等待后准备复核消耗本步模型额度，后续业务额度独立；不验证真实页面计时。
test('等待后的准备复核使用本步额度', async () => {
  const { report } = await run(finish, (_client, execution) => {
    structuredGrant(execution, [
      { type: 'setup', expected: [], wait: { durationMs: 5 } },
      {},
    ]);
    execution.task.stepBudget = compileStepBudget(execution.task);
  });
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['COMPLETED', 'COMPLETED'],
  );
  assert.equal(report.steps[0].budgetUsage.modelCalls, 1);
  assert.equal(report.steps[0].budgetUsage.actions, 0);
});

// 范围：暂停和过期快照的局部时钟规则，采用模拟服务端时间；不代表浏览器或人工登录验收。
test('业务人工等待暂停剩余时间，清理不暂停，旧步骤快照不覆盖新步骤', () => {
  const limit = { timeoutMs: 300_000, maxActions: 10, maxModelCalls: 20 };
  const business = new StepAllowance('s1', limit, 10, 20, false);
  const pausedAt = Date.now() - 60_000;
  business.sync({
    stepBudget: {
      stepId: 's1',
      actions: 3,
      modelCalls: 4,
      deadlineAt: pausedAt + 123_000,
      pausedAt,
    },
  });
  assert.equal(business.remaining(), 123_000);
  assert.deepEqual(business.available(13, 24), {
    actions: 7,
    modelCalls: 16,
    timeMs: 123_000,
  });
  business.sync({
    stepBudget: {
      stepId: 'old',
      actions: 0,
      modelCalls: 0,
      deadlineAt: 0,
      pausedAt: null,
    },
  });
  assert.equal(business.remaining(), 123_000);
  const cleanup = new StepAllowance('c1', limit, 0, 0, true);
  cleanup.sync({
    stepBudget: {
      stepId: 'c1',
      actions: 0,
      modelCalls: 0,
      deadlineAt: Date.now() - 1,
      pausedAt,
    },
  });
  assert.throws(() => cleanup.assertTime(), {
    code: 'STEP_TIME_BUDGET_EXCEEDED',
  });
});

// 范围：独立预算不取消无进展保护，且下一步仍核实自身条件；脚本模型不代表真实业务推理。
test('新预算保留无进展保护与后续步骤前置条件检查', async () => {
  const { report } = await run(
    (context) => {
      if (context.task.stepId === 'step-1') return { type: 'browser.observe' };
      assert.match(
        context.feedback.map((item) => item.message ?? item.code).join(' '),
        /前序异常：step-1/,
      );
      assert.match(
        context.feedback.map((item) => item.message ?? item.code).join(' '),
        /核实本步必要条件/,
      );
      return {
        type: 'verification.block',
        summary: '本步必要的访客状态尚未建立，不能判通过',
      };
    },
    (_client, execution) => {
      structuredGrant(execution, [{}, {}]);
      execution.task.stepBudget = compileStepBudget(execution.task);
    },
  );
  assert.equal(report.steps[0].reasonCode, 'NO_PROGRESS');
  assert(report.steps[0].budgetUsage.modelCalls < 20);
  assert.equal(report.steps[1].reasonCode, 'MODEL_BLOCKED');
  assert.equal(report.steps[1].budgetUsage.modelCalls, 1);
  assert.equal(report.verdict, null);
});

// 范围：命令在预算到期前已派发，必须先取得确定结果再换步；仅模拟延迟，不验证真实浏览器副作用。
test('步骤时间到期不中断在途动作，确认结果后继续下一步', async () => {
  let settled = false;
  const { report } = await run(
    (context) => {
      if (context.task.stepId === 'step-1')
        return {
          type: 'browser.act',
          action: 'fill',
          target: '@e1',
          value: 'Alice',
        };
      assert.equal(settled, true);
      return finish(context);
    },
    (client, execution) => {
      structuredGrant(execution, [{}, {}]);
      execution.task.stepBudget = compileStepBudget(execution.task);
      execution.task.stepBudget.steps[0].timeoutMs = 200;
      const command = client.command.bind(client);
      client.command = async (...args) => {
        if (args[2].type === 'browser.act' && args[2].action === 'fill') {
          await pause(300);
          settled = true;
        }
        return command(...args);
      };
    },
  );
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['BLOCKED', 'COMPLETED'],
  );
  assert.equal(report.steps[0].reasonCode, 'STEP_TIME_BUDGET_EXCEEDED');
  assert.equal(report.steps[0].budgetUsage.actions, 2);
});

// 范围：setup 身份前提未满足时阻止模型伪造完成及后续业务与清理；页面与模型均为夹具。
test('setup 身份缺失禁止执行后续业务及清理', async () => {
  const seen = [];
  const { report } = await run(
    (context) => {
      seen.push(context.task.stepId);
      return {
        ...finish(context),
        evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
      };
    },
    (_client, execution) => {
      structuredGrant(execution, [
        { type: 'setup', expected: [] },
        {},
        { type: 'setup', expected: [] },
      ]);
      execution.task.cleanupStepIds = ['step-3'];
      execution.task.steps[0].preconditions = [
        {
          id: 'member',
          description: '当前为测试团队成员',
          method: 'text',
          value: '测试团队成员',
        },
      ];
      execution.task.environment.allowIntervention = false;
    },
  );
  assert.deepEqual(seen, []);
  assert.equal(report.steps[0].reasonCode, 'ENVIRONMENT_NOT_READY');
  assert.equal(report.steps[0].preconditions[0].status, 'UNSATISFIED');
  assert.equal(report.steps[1].status, 'SKIPPED');
  assert.equal(report.steps[2].status, 'SKIPPED');
});

// 范围：人工会话不派发本地登录配方且按步骤执行；浏览器和模型为夹具。
test('人工会话直接执行，不尝试本地自动登录', async () => {
  const { report, client } = await run(
    (context) => ({
      ...finish(context),
      evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
    }),
    (_client, execution) => {
      structuredGrant(execution, [{}, {}]);
      execution.task.stepBudget = compileStepBudget(execution.task);
      execution.task.sessionPlan = {
        version: 1,
        mode: 'manual',
        preparationMs: 120000,
        requirements: [],
        candidates: [],
      };
    },
  );
  assert.ok(
    !client.calls.some((c) => c.operation.type === 'browser.identity.prepare'),
  );
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['COMPLETED', 'COMPLETED'],
  );
});

// 范围：结构化身份条件将登录和角色核验合并为一次 HITL；人工、网页与模型均为夹具。
test('结构化登录和角色确认共用一次环境准备人工请求', async () => {
  const execution = grant();
  structuredGrant(execution, [{ type: 'setup', expected: [] }]);
  execution.task.steps[0].description = '使用已授权账号登录后确认角色';
  execution.task.environment.allowIntervention = true;
  execution.task.sessionPlan = {
    version: 1,
    mode: 'manual',
    preparationMs: 120000,
    candidates: [],
    requirements: [
      {
        id: 'role',
        description: '确认当前账号是非所有者团队成员',
        method: 'manual',
      },
    ],
  };
  const client = new FakeControl();
  let mode = 'AUTO',
    revision = 0,
    requests = 0,
    resumed = false;
  const view = client.view.bind(client),
    command = client.command.bind(client);
  client.view = async (...args) => ({
    ...(await view(...args)),
    controlMode: mode,
    controlRevision: revision,
  });
  client.command = async (...args) => {
    const result = await command(...args);
    if (args[2].type === 'browser.observe' && !resumed) {
      result.data.url = 'https://example.com/login';
      result.data.targets = [
        { target: 'password', role: 'textbox', name: '密码' },
        { target: 'login', role: 'button', name: '登录' },
      ];
    }
    return result;
  };
  client.intervene = async (
    _grant,
    _rev,
    _reason,
    _signal,
    items,
    reasonCode,
  ) => {
    requests++;
    assert.equal(reasonCode, 'ENVIRONMENT_NOT_READY');
    assert.equal(items.length, 1);
    assert.match(items[0], /确认当前账号是非所有者团队成员/);
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
  const report = await execute(
    config,
    client,
    {
      async decide(input) {
        const context = JSON.parse(input.text);
        const { workflow, ...decision } = finish(context);
        return {
          workflow,
          decision: {
            ...decision,
            evidenceRefs: context.page.artifactRefs.map((a) => a.artifactId),
          },
          promptTokens: 0,
          completionTokens: 0,
        };
      },
    },
    execution,
  );
  assert.equal(requests, 1);
  assert.equal(report.steps[0].status, 'COMPLETED');
  assert.equal(report.steps[0].preconditions[0].source, 'human');
  assert.equal(report.steps[0].preconditions[0].status, 'SATISFIED');
});

// 范围：真实执行器把 setup 的人工确认传入后续模型上下文；交接和模型均为夹具，不证明真实登录或模型会遵循规则。
test('本步未声明条件时仍向模型提供有效的准备人工确认', async () => {
  const execution = grant();
  structuredGrant(execution, [
    {
      type: 'setup',
      expected: [],
      preconditions: [
        { id: 'account', method: 'manual', description: '人工确认当前账号' },
      ],
    },
    {},
  ]);
  execution.task.environment.allowIntervention = true;
  const client = new FakeControl();
  const view = client.view.bind(client);
  let mode = 'AUTO',
    revision = 0,
    requests = 0,
    seen = false;
  client.view = async (...args) => ({
    ...(await view(...args)),
    controlMode: mode,
    controlRevision: revision,
  });
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
  const report = await execute(
    config,
    client,
    {
      async decide(input) {
        const context = JSON.parse(input.text);
        if (
          ['PREPARING', 'CHECKING'].includes(context.state.phase) &&
          requests > 0
        ) {
          assert.match(
            context.feedback.map((item) => item.message ?? item.code).join(' '),
            /人工已交还/,
          );
          assert.match(
            context.feedback.map((item) => item.message ?? item.code).join(' '),
            /未确认、失效或冲突/,
          );
          assert.equal(
            context.state.conditions
              .filter((item) => item.scope === 'current')
              .map(({ scope: _scope, ...item }) => item)[0].status,
            'SATISFIED',
          );
        }
        if (context.state.phase === 'VERIFYING') {
          seen = true;
          assert.deepEqual(
            context.state.conditions
              .filter((item) => item.scope === 'current')
              .map(({ scope: _scope, ...item }) => item),
            [],
          );
          assert.equal(
            context.state.conditions
              .filter((item) => item.scope === 'preparation')
              .map(({ scope: _scope, ...item }) => item).length,
            1,
          );
          assert.equal(
            context.state.conditions
              .filter((item) => item.scope === 'preparation')
              .map(({ scope: _scope, ...item }) => item)[0].id,
            'account',
          );
          assert.equal(
            context.state.conditions
              .filter((item) => item.scope === 'preparation')
              .map(({ scope: _scope, ...item }) => item)[0].source,
            'human',
          );
          assert.equal(
            context.state.conditions
              .filter((item) => item.scope === 'preparation')
              .map(({ scope: _scope, ...item }) => item)[0].status,
            'SATISFIED',
          );
        }
        const { workflow, ...decision } = finish(context);
        return { workflow, decision, promptTokens: 0, completionTokens: 0 };
      },
    },
    execution,
  );
  assert.equal(seen, true);
  assert.equal(requests, 1);
  assert.equal(report.verdict, 'PASSED');
});
