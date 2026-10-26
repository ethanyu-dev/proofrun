import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validateControlRequest } from '../../contracts/dist/index.js';
import { execute } from '../../apps/agent/dist/execution/runner.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { config, grant, FakeControl, finish, modelServer } from './fixture.mjs';

/** 覆盖不同派发分支，包括定向按键、元素滚动、坐标零值及顶层导航。 */
const ACTIONS = [
  { action: 'navigate', target: 'https://fixture.test/next' },
  { action: 'tab.new', target: 'https://fixture.test/next' },
  ...['click', 'hover', 'check', 'uncheck'].map((action) => ({
    action,
    target: '@e2',
  })),
  ...['fill', 'type', 'select'].map((action) => ({
    action,
    target: '@e1',
    value: '',
  })),
  { action: 'type', value: '内容' },
  { action: 'press', target: '@e1', value: 'Tab' },
  { action: 'press', value: 'Escape' },
  { action: 'scroll', target: '@e2', value: 'down' },
  { action: 'scroll', value: 'up' },
  { action: 'visual.click', x: 0, y: 0 },
  { action: 'frame', target: '@frame' },
  { action: 'frame', target: 'main' },
  ...['back', 'forward', 'reload'].map((action) => ({ action })),
  ...['tab.switch', 'tab.close'].map((action) => ({ action, target: 'tab-1' })),
  { action: 'resize', value: '1440x900' },
];

// 范围：真实模型 HTTP 适配、执行器和控制协议校验；页面及动作回执为夹具，不代表真实浏览器验收。
test('所有浏览器意图派发时隔离 progress 和 revisitReason', async (suite) => {
  const decisions = [
    ...ACTIONS.map((action) => ({
      type: 'browser.act',
      ...action,
      revisitReason: '原步骤要求复核目标',
    })),
    { type: 'browser.wait', selector: 'body', text: '名称' },
    { type: 'browser.observe', screenshot: false },
  ];
  for (const decision of decisions) {
    // 每个变体独立执行：验证合法命令仍被派发，原始决策不被修改，证据绑定与派生参数没有丢失。
    await suite.test(
      `${decision.type}/${decision.action ?? ''}/${decision.target ?? ''}`,
      async () => {
        const execution = grant();
        const client = new FakeControl();
        const command = client.command.bind(client);
        client.image = async () => 'data:image/png;base64,Zml4dHVyZQ==';
        client.command = async (...args) => {
          const operation = args[2];
          assert.equal(
            validateControlRequest({
              type: 'execution.command',
              commandId: args[1],
              timeoutMs: 1000,
              controlRevision: 0,
              command: operation,
            }),
            true,
            JSON.stringify(validateControlRequest.errors),
          );
          const result = await command(...args);
          if (operation.type === 'browser.observe') {
            result.data.viewport = {
              width: 1000,
              height: 800,
              targetedPress: true,
              scrollDistance: true,
            };
            result.data.targets[1].operations = ['click', 'scroll'];
            result.data.targets.push({
              target: '@frame',
              role: 'iframe',
              name: '子页面',
            });
            const screenshot = {
              id: randomUUID(),
              kind: 'SCREENSHOT',
              sha256: 'b'.repeat(64),
              state: 'AVAILABLE',
            };
            client.artifacts.push(screenshot);
            result.data.artifactRefs.push({
              artifactId: screenshot.id,
              kind: screenshot.kind,
              sha256: screenshot.sha256,
            });
          }
          return result;
        };
        const original = { ...decision, progress: {} };
        const snapshot = structuredClone(original);
        const server = await modelServer((context, turn) =>
          turn === 1 ? original : finish(context),
        );
        const settings = { ...config, modelUrl: server.url, vision: true };
        try {
          const report = await execute(
            settings,
            client,
            new ChatModel(settings),
            execution,
          );
          assert.deepEqual(server.errors, []);
          assert.equal(
            report.verdict,
            'PASSED',
            JSON.stringify(report.executionDetails),
          );
          assert.equal(
            server.requests.length,
            2,
            '动作应成功执行，不应靠模型纠错绕过',
          );
          assert.deepEqual(original, snapshot);
          const sent = client.calls.filter(
            ({ operation }) =>
              operation.type === decision.type &&
              (decision.type !== 'browser.act' ||
                operation.action === decision.action),
          );
          assert(sent.length > 0);
          for (const { operation } of sent) {
            assert.equal('progress' in operation, false);
            assert.equal('revisitReason' in operation, false);
          }
          const actual = sent.at(-1).operation;
          if (decision.type === 'browser.act') {
            if (decision.target !== undefined)
              assert.equal(actual.target, decision.target);
            if (decision.action === 'scroll')
              assert.match(
                actual.value,
                new RegExp(`^${decision.value}:\\d+$`),
              );
            else if (decision.value !== undefined)
              assert.equal(actual.value, decision.value);
            if (decision.action === 'visual.click')
              assert.deepEqual([actual.x, actual.y], [0, 0]);
            if (
              [
                'click',
                'hover',
                'fill',
                'select',
                'check',
                'uncheck',
                'frame',
                'visual.click',
              ].includes(decision.action) ||
              (['press', 'scroll', 'type'].includes(decision.action) &&
                decision.target !== undefined)
            )
              assert(client.observedIds.includes(actual.observationId));
          }
        } finally {
          await server.close();
        }
      },
    );
  }
});

// 范围：真实执行器保留读取账本与重查围栏，只有协议字段进入控制面；控件和模型为夹具。
test('已读目标仍要求重查理由，理由只在本地消费', async () => {
  const client = new FakeControl();
  const command = client.command.bind(client);
  client.command = async (...args) => {
    assert.equal(
      validateControlRequest({
        type: 'execution.command',
        commandId: args[1],
        timeoutMs: 1000,
        controlRevision: 0,
        command: args[2],
      }),
      true,
      JSON.stringify(validateControlRequest.errors),
    );
    const result = await command(...args);
    if (args[2].type === 'browser.observe')
      result.data.targets[1].disclosure = {
        relation: 'aria-controls',
        expanded: true,
        visible: true,
        text: '夹具面板的答案',
        truncated: false,
      };
    return result;
  };
  const server = await modelServer((context, turn) => {
    if (turn === 1)
      return {
        type: 'browser.act',
        action: 'click',
        target: '@e2',
        progress: { readings: [{ itemId: 'item-1', quote: '夹具面板的答案' }] },
      };
    if (turn === 2) {
      assert.match(
        JSON.stringify(context.feedback),
        /INTERACTION_ALREADY_RECORDED/,
      );
      assert.equal(
        client.calls.filter((c) => c.operation.action === 'click').length,
        0,
      );
      return {
        type: 'browser.act',
        action: 'click',
        target: '@e2',
        revisitReason: '原任务要求核对面板收起行为',
      };
    }
    assert.deepEqual(context.state.readings.recordedItemIds, ['item-1']);
    return finish(context);
  });
  const settings = { ...config, modelUrl: server.url };
  try {
    const report = await execute(
      settings,
      client,
      new ChatModel(settings),
      grant(),
    );
    assert.deepEqual(server.errors, []);
    assert.equal(report.verdict, 'PASSED');
    assert.equal(server.requests.length, 3);
    assert.equal(
      client.calls.filter((c) => c.operation.action === 'click').length,
      1,
    );
  } finally {
    await server.close();
  }
});
