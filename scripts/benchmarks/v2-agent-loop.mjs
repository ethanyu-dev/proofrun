import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { execute } from '../../packages/execution-driver/dist/execution/runner.js';
import {
  V2_BENCHMARK_SUITE,
  benchmarkContext,
  benchmarkToolBatchValid,
  benchmarkPassed,
  parseBenchmark,
} from '../../contracts/dist/benchmark.js';
import { ROOT, sourceFingerprint } from './source.mjs';
import { releaseIdentity } from './release.mjs';
import { realConfig } from './real-config.mjs';
import { browserHost } from './browser-host.mjs';
import { V2Control } from './v2-control.mjs';
import {
  v2Cases,
  v2CallLimit,
  v2TimeLimit,
  V2_CONTEXT_CHARS,
} from './v2-cases.mjs';

/** 显式运行完整固定双任务；不提供单例筛选或失败后自动重新提交。 */
const { values } = parseArgs({
  options: {
    output: { type: 'string', default: resolve(ROOT, '.proofrun/benchmarks') },
    'env-file': { type: 'string' },
    version: { type: 'string' },
  },
});
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => stop.abort(new Error('V2 基准被中断')));

/** 失败也保留每项检查和全部原文，不删除失败任务。 */
function check(item, name, action) {
  try {
    item.checks.push({
      name,
      passed: true,
      detail: action() ?? '符合固定预期',
    });
  } catch (error) {
    item.checks.push({
      name,
      passed: false,
      detail:
        error.code === 'ERR_ASSERTION'
          ? error.message
          : (error.code ?? error.message),
    });
  }
}
/** 完整记录要求逐轮预算与步骤归属成立；正式允许的纯网络读取批次单独核验。 */
function checkCalls(item, task) {
  assert(
    item.calls.length > 0 && item.calls.length <= v2CallLimit(task),
    '模型调用总量超限或为空',
  );
  assert.equal(
    new Set(item.calls.map((call) => call.callIndex)).size,
    item.calls.length,
    '调用序号重复',
  );
  for (const call of item.calls) {
    assert.equal(
      call.status,
      'RECEIVED',
      `模型请求未完成：${call.error ?? call.status}`,
    );
    const context = benchmarkContext(call);
    assert(context && context.total <= V2_CONTEXT_CHARS, '上下文缺失或超限');
    assert(
      task.steps.some((step) => step.stepId === call.stepId),
      '缺少原任务步骤归属',
    );
    assert(benchmarkToolBatchValid(call, true), '非法工具批次');
  }
  for (const limit of task.stepBudget.steps)
    assert(
      item.calls.filter((call) => call.stepId === limit.stepId).length <=
        limit.maxModelCalls,
      `步骤 ${limit.stepId} 调用超限`,
    );
  const cleanup = new Set(task.cleanupStepIds);
  assert(
    item.calls.filter((call) => cleanup.has(call.stepId)).length <=
      task.stepBudget.cleanup.maxModelCalls,
    '清理调用超限',
  );
  return `${item.calls.length} 次真实请求，全部具有步骤、context 和工具原文`;
}
/** 真实生产站点读取，不使用本地业务页面或脚本模型；本地端口不代表线上调度验收。 */
async function main() {
  const cases = await v2Cases(),
    release = await releaseIdentity(values.version, false);
  let configured, configurationError;
  try {
    configured = await realConfig(values['env-file']);
  } catch (error) {
    configurationError = error;
  }
  let dirty = true;
  try {
    dirty = !!execFileSync('git', ['status', '--porcelain'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {}

  const run = {
    schemaVersion: 2,
    release,
    origin: process.env.CI ? 'ci' : 'local',
    suite: V2_BENCHMARK_SUITE,
    mode: 'real',
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    completedAt: null,
    source: {
      revision: release.commit ?? 'unversioned',
      dirty,
      fingerprint: release.sourceFingerprint,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    config: {
      model: configured?.settings.model ?? '未配置',
      maxTurns: Math.max(...cases.map((c) => v2CallLimit(c.task))),
      maxContextChars: V2_CONTEXT_CHARS,
    },
    runtime: configured?.identity ?? {
      ready: false,
      engineVersion: '',
      chromeVersion: '',
      hostSha256: '',
      engineSha256: '',
    },
    modelConfiguration: configured?.publicConfig ?? {
      vision: false,
      tokenParameter: 'unknown',
      maxTokens: 1,
      thinking: 'default',
      reasoningEffort: 'default',
      endpointFingerprint: '',
      modelMs: 1,
    },
    cases: [],
  };
  await mkdir(values.output, { recursive: true });
  const path = resolve(
    values.output,
    `${run.createdAt.replaceAll(':', '-')}-${run.id}.json`,
  );
  const save = async () => {
    await writeFile(path + '.tmp', JSON.stringify(run, null, 2) + '\n');
    await rename(path + '.tmp', path);
  };
  for (const scenario of cases) {
    const task = scenario.task,
      started = performance.now();
    const item = {
      id: scenario.id,
      name: scenario.name,
      scope:
        '真实模型 + 独立 Chrome + 真实生产站点；完整历史 V2 定义与预算。本地控制端口，不证明线上调度或生产可用率。',
      elapsedMs: 0,
      verdict: '未形成业务结论',
      checks: [],
      calls: [],
      commands: [],
      verification: {
        sourceTaskId: scenario.sourceTaskId,
        sourceCreatedAt: scenario.sourceCreatedAt,
        sourceDefinitionSha256: scenario.sourceDefinitionSha256,
        historicalVerdict: scenario.historicalVerdict,
        task,
        steps: [],
        report: null,
        sessionClosed: false,
      },
    };
    run.cases.push(item);
    let host, control;
    console.log(
      `开始 V2 ${scenario.name}（${task.steps.length} 步，保持原任务预算）`,
    );
    try {
      if (configurationError) throw configurationError;
      stop.signal.throwIfAborted();
      host = await browserHost(configured.runtime, v2TimeLimit(task), {
        networkEvidence: task.executionPlan.evidenceKinds.some((kind) =>
          ['NETWORK', 'RUNTIME'].includes(kind),
        ),
      });
      control = new V2Control(
        host,
        scenario,
        resolve(values.output, run.id, scenario.id),
      );
      const execution = {
        id: randomUUID(),
        leaseToken: 'local-v2-benchmark',
        nodeId: randomUUID(),
        sessionId: randomUUID(),
        state: 'STARTING',
        leaseExpiresAt: new Date(Date.now() + 30000).toISOString(),
        taskDeadlineAt: new Date(Date.now() + v2TimeLimit(task)).toISOString(),
        task,
      };
      const settings = {
        ...configured.settings,
        maxTurns: v2CallLimit(task),
        maxContextChars: V2_CONTEXT_CHARS,
        commandMs: 20000,
        evidenceMs: 5000,
      };
      const report = await execute(
        settings,
        control,
        new ChatModel(settings),
        execution,
        AbortSignal.any([stop.signal, AbortSignal.timeout(v2TimeLimit(task))]),
      );
      item.verdict = report.verdict ?? report.status ?? '未形成业务结论';
      item.verification.report = report;
      check(item, '原任务全部验收项通过', () => {
        assert.equal(report.verdict, 'PASSED');
      });
      check(item, '原任务全部步骤与清理完成', () => {
        assert.equal(control.steps.length, task.steps.length);
        assert(
          control.steps.every((step) => step.status === 'COMPLETED'),
          '存在错误、受阻或跳过的步骤',
        );
      });
    } catch (error) {
      check(item, '真实任务执行完成', () => {
        throw error;
      });
    } finally {
      if (control) {
        item.calls = [...control.calls.values()].sort(
          (a, b) => a.callIndex - b.callIndex,
        );
        item.commands = control.commands;
        item.verification.steps = control.steps;
      }
      if (host)
        try {
          await host.close();
          item.verification.sessionClosed = true;
        } catch (error) {
          check(item, '会话关闭', () => {
            throw error;
          });
        }
      item.elapsedMs = Math.round(performance.now() - started);
    }
    check(item, '完整逐轮记录与原预算', () => checkCalls(item, task));
    check(item, '真实会话已关闭', () => {
      assert(item.verification.sessionClosed);
    });
    const current = await sourceFingerprint();
    check(item, '测试期间源码未变化', () => {
      assert.equal(current, release.sourceFingerprint);
    });
    await save();
    console.log(
      `${benchmarkPassed(item) ? 'PASS' : 'FAIL'} V2 ${scenario.name} · ${item.calls.length} 轮`,
    );
  }
  run.completedAt = new Date().toISOString();
  // 即使末尾结构验证失败，也落盘终止标记和全部事实，不丢失实际执行结果。
  await save();
  parseBenchmark(JSON.stringify(run));
  console.log(`V2 基准归档：${path}`);
  if (!run.cases.every(benchmarkPassed)) process.exitCode = 1;
}
await main().catch((error) => {
  console.error(error.code ?? error.message);
  process.exitCode = 1;
});
