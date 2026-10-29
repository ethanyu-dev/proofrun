import { releaseIdentity } from './release.mjs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BENCHMARK_SUITE,
  CONTEXT_KEYS,
  benchmarkContext,
  benchmarkTools,
  benchmarkPassed,
  benchmarkComparison,
  benchmarkMetrics,
  parseBenchmark,
} from '../../contracts/dist/benchmark.js';
import { ChatModel } from '../../apps/agent/dist/model/chat.js';
import { execute } from '../../packages/execution-driver/dist/execution/runner.js';
import {
  config,
  grant,
  FakeControl,
  modelServer,
} from '../../tests/agent/fixture.mjs';
import { cases, LIMITS } from '../../tests/benchmarks/cases.mjs';

/** 固定根目录让 CLI 和 Console 启动采用同一源码与结果目录。 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** 同配置基线上下文峰值最多增加 10%，轮次数不能增加；耗时仅展示。 */
const CONTEXT_GROWTH = 1.1;

/** 镜像构建上下文通常不含 Git；缺失时明确标记未知，不能将其冒充干净提交。 */
function sourceIdentity() {
  try {
    return {
      revision: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
      dirty: !!execFileSync('git', ['status', '--porcelain'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim(),
    };
  } catch {
    return {
      revision:
        process.env.RAILWAY_GIT_COMMIT_SHA ||
        process.env.GITHUB_SHA ||
        'unversioned',
      dirty: true,
    };
  }
}

/** 只接受输出目录和显式基线，不允许跳过场景后产生发布通过结果。 */
function argumentsFor(argv) {
  const options = {
    output: resolve(ROOT, '.proofrun/benchmarks'),
    baseline: null,
    version: null,
  };
  for (let i = 0; i < argv.length; i += 2) {
    if (
      !['--output', '--baseline', '--version'].includes(argv[i]) ||
      !argv[i + 1] ||
      argv[i + 1].startsWith('--')
    )
      throw new Error(
        '用法：pnpm benchmark:agent [--output 目录] [--baseline 结果.json]',
      );
    options[argv[i].slice(2)] =
      argv[i] === '--version' ? argv[i + 1] : resolve(argv[i + 1]);
  }
  return options;
}

/** 记录执行端口实际收到的命令及回执；与模型意图分离，首轮前观察归入 0。 */
class BenchmarkControl extends FakeControl {
  commands = [];
  async command(execution, id, operation) {
    const starts = this.modelCalls.filter(
      (call) => call.body.phase === 'start',
    );
    const decisionIndex = starts.at(-1)?.body.record.decisionIndex ?? 0;
    const record = {
      decisionIndex,
      operation: structuredClone(operation),
      status: 'ERROR',
      effect: 'UNKNOWN',
    };
    this.commands.push(record);
    const result = await super.command(execution, id, operation);
    record.status = result.operationStatus;
    record.effect = result.effect;
    return result;
  }
}

/** 每个检查独立收集失败，不因第一条断言失败而丢弃该场景的调用记录。 */
function check(result, name, callback) {
  try {
    const detail = callback();
    result.checks.push({
      name,
      passed: true,
      detail: detail ?? '符合固定预期',
    });
  } catch (error) {
    result.checks.push({
      name,
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

/** 场景走真实执行器及 ChatModel HTTP；不接入外部模型、数据库或浏览器。 */
async function runCase(scenario) {
  const result = {
    id: scenario.id,
    name: scenario.name,
    scope: scenario.scope,
    elapsedMs: 0,
    verdict: 'ERROR',
    checks: [],
    calls: [],
    commands: [],
  };
  const control = new BenchmarkControl();
  const execution = grant();
  const started = performance.now();
  let server;
  try {
    scenario.prepare(control, execution);
    server = await modelServer(scenario.decide);
    const settings = { ...config, ...LIMITS, modelUrl: server.url };
    const report = await execute(
      settings,
      control,
      new ChatModel(settings),
      execution,
    );
    result.verdict = report.verdict ?? report.status ?? '未形成业务结论';
    check(result, '场景业务与副作用断言', () =>
      scenario.verify(control, report),
    );
    check(result, '模型 HTTP 夹具无异常', () =>
      requireValue(
        server.errors.length === 0,
        server.errors.map(String).join('\n'),
      ),
    );
  } catch (error) {
    result.checks.push({
      name: '循环执行完成',
      passed: false,
      detail: String(error),
    });
  } finally {
    await server?.close();
    result.elapsedMs = Math.round(performance.now() - started);
    const calls = new Map();
    for (const { id, body } of control.modelCalls) {
      if (body.phase === 'start') calls.set(id, body.record);
      else if (calls.has(id)) Object.assign(calls.get(id), body.result);
    }
    result.calls = [...calls.values()];
    result.commands = control.commands;
  }
  check(result, '决策轮数门限', () => {
    requireValue(
      result.calls.length > 0 && result.calls.length <= scenario.maxRounds,
      `实际 ${result.calls.length} 轮，要求 1–${scenario.maxRounds} 轮`,
    );
    return `${result.calls.length} / ${scenario.maxRounds} 轮`;
  });
  check(result, '七模块、请求回执与单轮单工具', () => {
    const rounds = new Set();
    for (const call of result.calls) {
      const context = benchmarkContext(call);
      requireValue(
        call.status === 'RECEIVED' &&
          context &&
          Object.keys(context.context).join() === CONTEXT_KEYS.join(),
        `轮次 ${call.decisionIndex} 请求或模块缺失`,
      );
      requireValue(!rounds.has(call.decisionIndex), '同轮出现多次模型请求');
      rounds.add(call.decisionIndex);
      requireValue(
        benchmarkTools(call).length === 1,
        '每次模型回复必须只提出一个工具',
      );
    }
  });
  check(result, '上下文硬上限', () => {
    const peak = benchmarkMetrics(result).peakContext;
    requireValue(
      peak > 0 && peak <= LIMITS.peakContext,
      `峰值 ${peak}，上限 ${LIMITS.peakContext}`,
    );
    return `${peak} / ${LIMITS.peakContext} 字符`;
  });
  return result;
}

/** 结果先完整落盘再设置退出码，失败归档同样可在看板复盘。 */
async function main() {
  const options = argumentsFor(process.argv.slice(2));
  const baseline = options.baseline
    ? parseBenchmark(await readFile(options.baseline, 'utf8'))
    : null;
  const release = await releaseIdentity(options.version);
  const run = {
    schemaVersion: 2,
    release,
    origin: process.env.CI ? 'ci' : 'local',
    suite: BENCHMARK_SUITE,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: { ...sourceIdentity(), fingerprint: release.sourceFingerprint },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    config: {
      model: config.model,
      maxContextChars: LIMITS.maxContextChars,
      maxTurns: LIMITS.maxTurns,
    },
    mode: 'scripted',
    cases: [],
  };
  for (const scenario of cases) run.cases.push(await runCase(scenario));
  if (baseline) {
    const mismatch = benchmarkComparison(run, baseline);
    for (const item of run.cases)
      check(item, '显式基线回归门禁', () => {
        requireValue(!mismatch, mismatch);
        const before = benchmarkMetrics(
          baseline.cases.find((entry) => entry.id === item.id),
        );
        const after = benchmarkMetrics(item);
        requireValue(
          after.rounds <= before.rounds &&
            after.peakContext <= Math.ceil(before.peakContext * CONTEXT_GROWTH),
          `轮数 ${before.rounds} → ${after.rounds}；上下文峰值 ${before.peakContext} → ${after.peakContext}（最多 +10%）`,
        );
        return `基线 ${baseline.id}；轮数不增加，上下文峰值 ≤ +10%`;
      });
  }
  parseBenchmark(JSON.stringify(run));
  const output = resolve(
    options.output,
    `${run.createdAt.replaceAll(':', '-')}-${run.id}.json`,
  );
  await mkdir(dirname(output), { recursive: true });
  await writeFile(`${output}.tmp`, JSON.stringify(run, null, 2) + '\n');
  await rename(`${output}.tmp`, output);
  for (const item of run.cases) {
    console.log(
      `${benchmarkPassed(item) ? 'PASS' : 'FAIL'} ${item.name} · ${item.calls.length} 轮 · ${benchmarkMetrics(item).peakContext} 字符`,
    );
    for (const check of item.checks.filter((entry) => !entry.passed))
      console.error(`  ${check.name}: ${check.detail}`);
  }
  console.log(`结果：${output}`);
  if (!run.cases.every(benchmarkPassed)) process.exitCode = 1;
}
await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
