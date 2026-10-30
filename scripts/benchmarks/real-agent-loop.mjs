import { releaseIdentity } from './release.mjs';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import {
  REAL_BENCHMARK_SUITE,
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
import { ROOT, sourceFingerprint } from './source.mjs';
import { browserHost } from './browser-host.mjs';
import { realConfig } from './real-config.mjs';
import { RealControl } from './real-control.mjs';
import { realSite } from '../../tests/benchmarks/real-site.mjs';
import {
  realCases,
  realGrant,
  verifyRealCase,
  REAL_LIMITS,
} from '../../tests/benchmarks/real-cases.mjs';

/** 中断时停止真实模型调用并进入资源关闭；不对失败场景追加重跑。 */
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => stop.abort(new Error('真实基准被中断')));
const { values } = parseArgs({
  options: {
    output: { type: 'string', default: resolve(ROOT, '.proofrun/benchmarks') },
    'env-file': { type: 'string' },
    baseline: { type: 'string' },
    version: { type: 'string' },
    'release-report': { type: 'string' },
  },
});

/** 判定失败保留错误，避免未完成的场景从分母中消失。 */
function check(result, name, action) {
  try {
    const detail = action();
    result.checks.push({
      name,
      passed: true,
      detail: detail ?? '符合固定预期',
    });
  } catch (error) {
    result.checks.push({
      name,
      passed: false,
      detail:
        error.code === 'ERR_ASSERTION'
          ? error.message
          : (error.code ?? error.message ?? '执行失败'),
    });
  }
}
function requireValue(value, message) {
  if (!value) throw new Error(message);
}
async function save(path, run) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path + '.tmp', JSON.stringify(run, null, 2) + '\n');
  await rename(path + '.tmp', path);
}

/** 完整串行运行真实模型与独立 Chrome，原文落盘后才给出发布检查结果。 */
async function main() {
  // 参数预检失败也废弃旧候选，不能让缺少版本的新尝试继续沿用旧通过结果。
  if (values['release-report'])
    await save(resolve(values['release-report']), {
      invalidatedAt: new Date().toISOString(),
      reason: '新发布基准开始，等待完整结果',
    });
  const release = await releaseIdentity(
    values.version,
    !!values['release-report'],
  );
  const fingerprint = release.sourceFingerprint;
  let revision = 'unversioned',
    dirty = true;
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    dirty = !!execFileSync('git', ['status', '--porcelain'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {}
  const run = {
    schemaVersion: 2,
    release,
    origin: process.env.CI ? 'ci' : 'local',
    suite: REAL_BENCHMARK_SUITE,
    mode: 'real',
    completedAt: null,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: { revision, dirty, fingerprint },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    config: {
      model: '未配置',
      maxTurns: REAL_LIMITS.maxTurns,
      maxContextChars: REAL_LIMITS.maxContextChars,
    },
    runtime: {
      ready: false,
      engineVersion: '',
      chromeVersion: '',
      hostSha256: '',
      engineSha256: '',
    },
    modelConfiguration: {
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
  const output = resolve(
    values.output,
    `${run.createdAt.replaceAll(':', '-')}-${run.id}.json`,
  );
  if (values['release-report'])
    await save(resolve(values['release-report']), run);
  let configured, preflightError, site;
  try {
    configured = await realConfig(values['env-file']);
    run.runtime = configured.identity;
    run.modelConfiguration = configured.publicConfig;
    run.config.model = configured.settings.model;
    site = await realSite();
  } catch (error) {
    preflightError = error;
  }
  try {
    for (const scenario of realCases) {
      const item = {
        id: scenario.id,
        name: scenario.name,
        scope:
          '真实模型 + 独立 Chrome + 本地合成业务；控制面为本地端口。旧观察及丢回执场景含明确故障注入，不代表生产故障发生率。',
        elapsedMs: 0,
        verdict: '未形成业务结论',
        checks: [],
        calls: [],
        commands: [],
        facts: { visits: 0, writes: [], sessionClosed: false, injected: false },
      };
      run.cases.push(item);
      const started = performance.now();
      let host, control;
      console.log(
        `开始 ${scenario.name}（最多 ${REAL_LIMITS.maxTurns} 次真实模型调用）`,
      );
      try {
        if (preflightError) throw preflightError;
        stop.signal.throwIfAborted();
        host = await browserHost(configured.runtime, REAL_LIMITS.timeoutMs, {
          // 网络场景必须启动真实 CDP 采集，不能靠观察投影或模型声明补造证据。
          networkEvidence: scenario.id.startsWith('network-'),
        });
        const execution = realGrant(scenario, site.origin);
        control = new RealControl(
          host,
          site,
          scenario,
          resolve(values.output, run.id, scenario.id),
        );
        const settings = {
          ...configured.settings,
          apiUrl: site.origin,
          maxTurns: REAL_LIMITS.maxTurns,
          maxContextChars: REAL_LIMITS.maxContextChars,
          commandMs: 20000,
          evidenceMs: 5000,
        };
        const report = await execute(
          settings,
          control,
          new ChatModel(settings),
          execution,
          AbortSignal.any([
            stop.signal,
            AbortSignal.timeout(REAL_LIMITS.timeoutMs),
          ]),
        );
        item.verdict =
          report.browserResult?.outcome ?? report.verdict ?? '未形成业务结论';
        if (report.browserResult) item.browserResult = report.browserResult;
        check(item, '真实业务事实与副作用', () =>
          verifyRealCase(scenario, control, report, site.facts(scenario.id)),
        );
      } catch (error) {
        check(item, '真实执行完成', () => {
          throw error;
        });
      } finally {
        if (control) {
          item.calls = [...control.calls.values()];
          item.commands = control.commands;
          item.facts = {
            ...site.facts(scenario.id),
            injected: control.injected,
            sessionClosed: false,
          };
        }
        if (host) {
          try {
            await host.close();
            item.facts.sessionClosed = true;
          } catch (error) {
            check(item, '会话关闭', () => {
              throw error;
            });
          }
        }
        item.elapsedMs = Math.round(performance.now() - started);
      }
      check(item, '真实会话已关闭', () =>
        requireValue(item.facts.sessionClosed, '缺少宿主正常关闭证明'),
      );
      check(item, '完整逐轮记录与预算', () => {
        requireValue(
          item.calls.length > 0 && item.calls.length <= REAL_LIMITS.maxTurns,
          `真实调用数 ${item.calls.length}`,
        );
        requireValue(
          new Set(item.calls.map((call) => call.decisionIndex)).size ===
            item.calls.length,
          '同轮出现重复模型调用',
        );
        for (const call of item.calls) {
          const context = benchmarkContext(call),
            tools = benchmarkTools(call);
          requireValue(
            call.status === 'RECEIVED',
            `轮次 ${call.decisionIndex} 模型请求未完成：${call.status}`,
          );
          requireValue(
            tools.length === 1,
            `轮次 ${call.decisionIndex} 返回 ${tools.length} 个工具（${tools.map((tool) => tool.name).join(', ')}），固定门限为单工具`,
          );
          requireValue(
            context &&
              Object.keys(context.context).join() === CONTEXT_KEYS.join(),
            `轮次 ${call.decisionIndex} 缺少完整七模块上下文`,
          );
          requireValue(
            context.total <= REAL_LIMITS.maxContextChars,
            `轮次 ${call.decisionIndex} 上下文 ${context.total} 超过 ${REAL_LIMITS.maxContextChars} 字符`,
          );
        }
        return `${item.calls.length} / ${REAL_LIMITS.maxTurns} 轮；峰值 ${benchmarkMetrics(item).peakContext} / ${REAL_LIMITS.maxContextChars} 字符`;
      });
      await save(output, run);
      console.log(
        `${benchmarkPassed(item) ? 'PASS' : 'FAIL'} ${scenario.name} · ${item.calls.length} 轮`,
      );
      for (const entry of item.checks.filter((entry) => !entry.passed))
        console.error(`  ${entry.name}: ${entry.detail}`);
    }
  } finally {
    await site?.close();
  }
  const unchanged = fingerprint === (await sourceFingerprint());
  for (const item of run.cases)
    check(item, '测试期间源码未变化', () =>
      requireValue(unchanged, '源码已变化，不能将这次运行用于发布'),
    );
  if (values.baseline) {
    let baseline, error;
    try {
      baseline = parseBenchmark(
        await readFile(resolve(values.baseline), 'utf8'),
      );
      error = benchmarkComparison(run, baseline);
    } catch (cause) {
      error = cause.message;
    }
    for (const item of run.cases)
      check(item, '真实基线回归门禁', () => {
        requireValue(!error, error);
        const before = benchmarkMetrics(
            baseline.cases.find((entry) => entry.id === item.id),
          ),
          after = benchmarkMetrics(item);
        requireValue(
          after.rounds <= before.rounds &&
            after.peakContext <= Math.ceil(before.peakContext * 1.1),
          `轮次 ${before.rounds} → ${after.rounds}，上下文峰值 ${before.peakContext} → ${after.peakContext}`,
        );
      });
  }
  run.completedAt = new Date().toISOString();
  parseBenchmark(JSON.stringify(run));
  await save(output, run);
  // 发布候选文件失败也覆盖，防止最近一次失败后误用旧的通过候选。
  if (values['release-report'])
    await save(resolve(values['release-report']), run);
  console.log(`真实结果：${output}`);
  if (!run.cases.every(benchmarkPassed)) process.exitCode = 1;
}
await main().catch((error) => {
  console.error(error.code ?? error.message);
  process.exitCode = 1;
});
