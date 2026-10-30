import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { v2Cases, v2CallLimit } from '../../scripts/benchmarks/v2-cases.mjs';
import { benchmarkToolBatchValid } from '../../contracts/dist/benchmark.js';
import { V2Control } from '../../scripts/benchmarks/v2-control.mjs';

// 范围：冻结历史来源和预算，不允许导入时删步骤或改验收；不调用真实模型、站点或账号。
test('V2 固定双任务保留完整历史定义和逐步预算', async () => {
  const cases = await v2Cases();
  assert.deepEqual(
    cases.map((c) => c.task.steps.length),
    [14, 9],
  );
  for (const item of cases) {
    const source = JSON.parse(
      await readFile(new URL(`./v2/${item.id}.json`, import.meta.url), 'utf8'),
    );
    for (const key of [
      'steps',
      'acceptanceCriteria',
      'stepBudget',
      'profilePlan',
      'budget',
      'caseV2Definition',
    ])
      assert.deepEqual(item.task[key], source.task[key]);
    assert.equal(item.task.environment.allowIntervention, false);
    assert.equal(item.task.resourceKey, undefined);
    assert.notEqual(item.task.taskId, source.task.taskId);
    assert(v2CallLimit(item.task) > 0);
  }
});

// 范围：模拟宿主回执检查并行组归属、来源导航及证据类型；夹具不代表真实浏览器或生产业务验收。
test('V2 命令绑定原步骤模型调用，运行时证据只登记实际回执', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'proofrun-v2-control-'));
  const scenario = (await v2Cases())[1];
  const host = {
    directory,
    environmentProof: { initialState: 'empty', authRestored: false },
    async command() {
      return { Ok: { runtime: { version: 1 }, network: { requests: [] } } };
    },
  };
  try {
    const control = new V2Control(host, scenario, directory);
    control.calls.set('first', {
      id: 'first',
      decisionIndex: 1,
      stepId: 'step-1',
    });
    control.calls.set('second', {
      id: 'second',
      decisionIndex: 1,
      stepId: 'step-2',
    });
    const execution = { nodeId: 'node', sessionId: 'session', id: 'execution' };
    const result = await control.command(
      execution,
      'command',
      { type: 'browser.observe' },
      1000,
      undefined,
      0,
      'step-1',
    );
    assert.equal(control.commands[0].callId, 'first');
    assert.equal(control.commands[0].stepId, 'step-1');
    assert.deepEqual(
      result.data.artifactRefs.map((ref) => ref.kind),
      ['DOM', 'NETWORK', 'RUNTIME'],
    );
    assert.equal(
      (await control.view(execution)).environmentProof.sessionId,
      'session',
    );
    assert.throws(
      () =>
        control.authorize({
          type: 'browser.act',
          action: 'navigate',
          target: 'https://outside.test',
        }),
      /任务之外/,
    );
    host.command = async () => ({ Ok: {} });
    const absent = await control.command(
      execution,
      'absent',
      { type: 'browser.observe' },
      1000,
      undefined,
      0,
      'step-2',
    );
    assert.deepEqual(
      absent.data.artifactRefs.map((ref) => ref.kind),
      ['DOM'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// 范围：并发模拟宿主让回执乱序完成，验证每条命令仍保留自身观察；不替代真实站点或浏览器验收。
test('并发观察不会把证据回写到其他分组的命令', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'proofrun-v2-parallel-'));
  const scenario = (await v2Cases())[0];
  let releaseFirst;
  const waiting = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const host = {
    directory,
    async command(operation) {
      if (operation.tabScope === 'first') await waiting;
      else releaseFirst();
      return {
        Ok: {
          text: operation.tabScope,
          network: { scope: operation.tabScope },
        },
      };
    },
  };
  try {
    const control = new V2Control(host, scenario, directory);
    const execution = { nodeId: 'node', sessionId: 'session', id: 'execution' };
    await Promise.all(
      ['first', 'second'].map((id) =>
        control.command(
          execution,
          id,
          { type: 'browser.observe', tabScope: id },
          1000,
          undefined,
          0,
          id,
        ),
      ),
    );
    for (const command of control.commands) {
      assert.equal(command.result.text, command.operation.tabScope);
      assert.equal(command.result.network.scope, command.operation.tabScope);
      assert(command.result.artifactRefs.some((ref) => ref.kind === 'NETWORK'));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// 范围：只校验原文工具批次规则，V2 纯读取例外不能放宽基础发布套件，不调用供应商模型。
test('V2 只允许既有纯网络读取批次，基础门禁仍拒绝多工具', () => {
  const call = {
    response: JSON.stringify({
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: 'network_requests', arguments: '{}' } },
              { function: { name: 'network_request_detail', arguments: '{}' } },
            ],
          },
        },
      ],
    }),
  };
  assert.equal(benchmarkToolBatchValid(call), false);
  assert.equal(benchmarkToolBatchValid(call, true), true);
  const body = JSON.parse(call.response);
  body.choices[0].message.tool_calls[0].function.arguments = '{"progress":{}}';
  assert.equal(
    benchmarkToolBatchValid({ response: JSON.stringify(body) }, true),
    false,
  );
  body.choices[0].message.tool_calls[0].function = {
    name: 'browser_act',
    arguments: '{}',
  };
  assert.equal(
    benchmarkToolBatchValid({ response: JSON.stringify(body) }, true),
    false,
  );
});

// 范围：配置预检失败仍按版本保存完整失败分母；不启动真实模型或浏览器，不冒充业务验收。
test('V2 配置失败也归档版本与两个失败任务', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'proofrun-v2-preflight-'));
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--',
        'scripts/benchmarks/v2-agent-loop.mjs',
        '--version',
        'v2-preflight-test',
        '--output',
        directory,
        '--env-file',
        join(directory, 'missing.env'),
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(result.status, 1, result.stderr);
    const file = (await readdir(directory)).find((name) =>
      name.endsWith('.json'),
    );
    assert(file, result.stderr);
    const run = JSON.parse(await readFile(join(directory, file), 'utf8'));
    assert.equal(run.release.version, 'v2-preflight-test');
    assert.equal(run.runtime.ready, false);
    assert(run.completedAt);
    assert.equal(run.cases.length, 2);
    assert(run.cases.every((item) => item.preflight === undefined));
    assert(
      run.cases.every(
        (item) =>
          item.calls.length === 0 && item.checks.some((check) => !check.passed),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
