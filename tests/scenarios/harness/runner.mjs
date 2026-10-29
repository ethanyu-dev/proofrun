import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  compileStepBudget,
  validateVerificationCaseV2,
  validateTaskDetail,
} from '../../../contracts/dist/index.js';
import {
  CASES,
  SCENARIO_VERSION,
  definition,
  suite,
} from '../cases/catalog.mjs';
import { fixtureRequest } from '../fixture/server.mjs';
import { evaluate, ORACLE_VERSION } from '../oracles/evaluate.mjs';
import { Control, collect } from './client.mjs';
import { assist } from './human.mjs';
import { summarize } from './summary.mjs';
import {
  FORMAT_VERSION,
  ID,
  canonical,
  digest,
  lock,
  read,
  save,
} from './storage.mjs';

/** 每个样本串行运行，profile 内部并发仍由产品冻结计划决定。 */
const POLL_MS = 1000;
const ACTIVE = new Set(['QUEUED', 'RUNNING']);
const exec = promisify(execFile);

/** 统计产品现有逐步上限，派发前预留整例额度；不因样本失败追加次数。 */
export function callAllowance(input) {
  const cleanupStepIds = input.cleanup.map((s) => s.stepId);
  const budget = compileStepBudget({
    steps: [
      ...input.steps,
      ...input.cleanup.map((s) => ({ ...s, type: 'setup' })),
    ],
    cleanupStepIds,
  });
  return (
    budget.steps.reduce((n, step) => n + step.maxModelCalls, 0) +
    (input.cleanup.length ? budget.cleanup.maxModelCalls : 0)
  );
}

/** 采集当前源码身份；部署身份使用单独的声明字段和节点运行时，不冒充同一事实。 */
async function sourceIdentity() {
  // 只读容器挂载与运行用户的 uid 可不同；仅对当前显式工作目录授权读取 Git 身份。
  const command = async (...args) =>
    (
      await exec('git', ['-c', `safe.directory=${process.cwd()}`, ...args])
    ).stdout.trim();
  return {
    commit: await command('rev-parse', 'HEAD'),
    dirty: !!(await command('status', '--porcelain')),
    diffSha256: digest(await command('diff', 'HEAD')),
  };
}

/** 清单覆盖页面、业务实现和判定器，任何语义修改均使恢复或对比显式失败。 */
export async function scenarioDigest() {
  const files = [
    'cases/catalog.mjs',
    'fixture/pages.mjs',
    'fixture/server.mjs',
    'oracles/evaluate.mjs',
  ];
  return digest(
    await Promise.all(
      files.map(async (file) => [
        file,
        await readFile(new URL(`../${file}`, import.meta.url), 'utf8'),
      ]),
    ),
  );
}

/** 可重放的排序种子只控制执行顺序；本版不声称覆盖随机生成页面。 */
export function planSamples(runId, scenarios, repeat, seed) {
  return Array.from({ length: repeat }, (_, index) =>
    scenarios.map((s) => ({
      id: `${runId}-${s.id}-${index + 1}`,
      scenarioId: s.id,
      key: `${s.id}:${index + 1}`,
      repeat: index + 1,
    })),
  )
    .flat()
    .sort((a, b) =>
      digest(`${seed}:${a.key}`).localeCompare(digest(`${seed}:${b.key}`)),
    );
}

/** 恢复提交始终查询原请求；同身份重送依赖 Case API 的原子幂等，不创造新任务。 */
export async function ensureSubmitted(control, sample, persist) {
  let request = await control.findRequest(sample.id);
  if (!request) {
    sample.submissionIntentAt ??= new Date().toISOString();
    await persist();
    await control.json('/v2/cases', sample.submission);
    request = await control.findRequest(sample.id);
  }
  if (
    !request ||
    request.cases.length !== 1 ||
    request.cases[0].caseId !== sample.id ||
    request.cases[0].arms.length !== 1
  )
    throw new Error('REQUEST_IDENTITY_OR_MODE_MISMATCH');
  return request.cases[0].arms[0].taskId;
}

/** 等待中断后仅取消本样本并收集关闭事实；不会重放业务动作或移除未确认会话。 */
export async function executeSample({
  control,
  sample,
  scenario,
  directory,
  options,
  stop,
  getFixture = fixtureRequest,
  wait = delay,
}) {
  const persist = () => save(join(directory, 'sample.json'), sample);
  const snapshot = () => getFixture(options.socketPath, sample.id);
  sample.taskId = await ensureSubmitted(control, sample, persist);
  await persist();
  let detail;
  let closingAt = sample.closingAt ? Date.parse(sample.closingAt) : null;
  const cancel = async (reason) => {
    sample.cancelIntent ??= { at: new Date().toISOString(), reason };
    await persist();
    try {
      await control.json(`/v2/cases/${sample.id}/cancel`, {});
    } catch {
      /* 回执未知，下一轮查询后可重送同一取消请求。 */
    }
  };
  for (;;) {
    detail = await control.json(
      `/v1/tasks/${encodeURIComponent(sample.taskId)}`,
    );
    if (!validateTaskDetail(detail)) throw new Error('INVALID_TASK_DETAIL');
    if (
      canonical(detail.definition.caseV2Definition) !==
      canonical(sample.submission.cases[0])
    )
      throw new Error('FROZEN_DEFINITION_MISMATCH');
    if (detail.definition.executionMode !== options.mode) {
      await cancel('EXECUTION_MODE_MISMATCH');
      throw new Error('EXECUTION_MODE_MISMATCH');
    }
    if (!sample.budget) {
      sample.budget = detail.definition.stepBudget;
      sample.executionPlan = detail.definition.executionPlan;
      sample.profilePlan = detail.definition.profilePlan;
      await persist();
    }
    const now = Date.now();
    if (detail.state !== 'QUEUED')
      sample.startedAt ??= new Date().toISOString();
    if (!ACTIVE.has(detail.state)) {
      closingAt ??= now;
      sample.closingAt ??= new Date(closingAt).toISOString();
      await persist();
      if (
        detail.executions.length &&
        detail.executions.every((e) => e.closure_verified)
      )
        break;
      if (!detail.executions.length || now - closingAt >= options.closeMs)
        break;
    } else {
      const submitted = Date.parse(sample.submissionIntentAt);
      if (sample.cancelIntent) await cancel(sample.cancelIntent.reason);
      else if (stop.aborted) await cancel('RUN_INTERRUPTED');
      else if (options.deadline && now >= options.deadline)
        await cancel('RUN_TIME_LIMIT');
      else if (detail.state === 'QUEUED' && now - submitted > options.queueMs)
        await cancel('QUEUE_TIMEOUT');
      else if (now - submitted > options.sampleMs)
        await cancel('SAMPLE_TIMEOUT');
      // 取消请求丢回执时继续查原任务；确认仍活动可幂等重送取消，不重送业务操作。
      if (
        sample.cancelIntent &&
        now - Date.parse(sample.cancelIntent.at) > options.closeMs
      )
        break;
      if (scenario.kind === 'human' && !sample.cancelIntent) {
        for (const execution of detail.executions) {
          const { intervention } = await control.json(
            `/v1/admin/executions/${execution.id}/intervention`,
          );
          if (
            intervention &&
            sample.human?.interventionId !== intervention.id
          ) {
            try {
              sample.human = await assist(
                control,
                intervention,
                sample.id,
                snapshot,
              );
            } catch (error) {
              // 人工脚本失败也须收集本任务事实，确认关闭后再运行其他样本；不重放人工输入。
              sample.humanError =
                error instanceof Error && /^[A-Z_]+$/.test(error.message)
                  ? error.message
                  : 'HITL_HELPER_FAILED';
              await cancel('HITL_HELPER_FAILED');
              break;
            }
            await persist();
          }
        }
      }
    }
    await wait(POLL_MS);
  }
  const captured = await collect(control, detail, directory);
  const state = await snapshot();
  const { code: _, ...publicFacts } = state;
  await save(join(directory, 'task.json'), detail);
  await save(join(directory, 'facts.json'), publicFacts);
  await save(join(directory, 'calls.json'), captured.calls);
  await save(
    join(directory, 'evidence.json'),
    captured.artifacts.map(({ text: _, ...a }) => a),
  );
  sample.result = evaluate({
    scenario,
    detail,
    state,
    artifacts: captured.artifacts,
    captureErrors: [
      ...captured.errors,
      ...(sample.humanError ? [sample.humanError] : []),
    ],
  });
  sample.calls = captured.calls;
  sample.elapsedMs = Date.now() - Date.parse(sample.submissionIntentAt);
  sample.finishedAt = new Date().toISOString();
  sample.error = null;
  await persist();
  return sample;
}

/** 运行只连接显式配置的隔离环境；不读取开发机默认凭据，也不自动重启已有服务。 */
export async function run(options) {
  const directory = resolve(options.output);
  const release = await lock(directory);
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const manifestPath = join(directory, 'manifest.json');
    let manifest = await read(manifestPath);
    const codeDigest = await scenarioDigest();
    if (manifest && !options.resume)
      throw new Error('输出目录已有运行，使用 --resume 恢复');
    if (!manifest && options.resume) throw new Error('找不到恢复清单');
    if (
      manifest &&
      (manifest.scenarioDigest !== codeDigest ||
        manifest.controlOrigin !== new URL(options.apiUrl).origin ||
        manifest.fixtureUrl !== options.fixtureUrl ||
        canonical(manifest.environment) !== canonical(options.environment))
    )
      throw new Error('恢复配置或场景版本发生变化');
    const control = new Control(options.apiUrl, options.token);
    if (!manifest) {
      const runId = `eval-${randomUUID().slice(0, 12)}`;
      manifest = {
        formatVersion: FORMAT_VERSION,
        oracleVersion: ORACLE_VERSION,
        scenarioVersion: SCENARIO_VERSION,
        scenarioDigest: codeDigest,
        runId,
        suite: options.suite,
        repeat: options.repeat,
        seed: options.seed,
        createdAt: new Date().toISOString(),
        source: await sourceIdentity(),
        controlOrigin: control.origin,
        fixtureUrl: options.fixtureUrl,
        environment: options.environment,
        limits: {
          maxCalls: options.maxCalls,
          maxDurationMs: options.maxDurationMs,
          queueMs: options.queueMs,
          sampleMs: options.sampleMs,
          closeMs: options.closeMs,
        },
        samples: planSamples(
          runId,
          suite(options.suite),
          options.repeat,
          options.seed,
        ),
      };
      await save(manifestPath, manifest);
    }
    options = {
      ...options,
      ...manifest.limits,
      mode: manifest.environment.mode,
      fixtureUrl: manifest.fixtureUrl,
    };
    await control.json('/health/ready');
    const nodes = await control.json('/v1/nodes');
    await save(join(directory, 'nodes.json'), nodes);
    const samples = [];
    let reservedCalls = 0;
    const invocationStarted = Date.now();
    // 中断后的继续运行拥有同一总额度；已经启动的样本先对账，不能被新限额跳过。
    const previousElapsed =
      (manifest.elapsedMs ?? 0) +
      (manifest.activeSince
        ? Math.max(0, Date.now() - Date.parse(manifest.activeSince))
        : 0);
    manifest.activeSince = new Date(invocationStarted).toISOString();
    manifest.elapsedMs = previousElapsed;
    await save(manifestPath, manifest);
    options.deadline =
      invocationStarted + Math.max(0, options.maxDurationMs - previousElapsed);
    for (const planned of manifest.samples) {
      if (!ID.test(planned.id)) throw new Error('清单样本身份无效');
      const path = join(directory, planned.id);
      await mkdir(path, { recursive: true, mode: 0o700 });
      let sample = (await read(join(path, 'sample.json'))) ?? { ...planned };
      samples.push(sample);
      const scenario = CASES.find((c) => c.id === planned.scenarioId);
      const input = definition(scenario, sample.id, options.fixtureUrl);
      if (!validateVerificationCaseV2(input))
        throw new Error('场景定义不满足 Case v2 Schema');
      const allowance = callAllowance(input);
      if (sample.submissionIntentAt) reservedCalls += allowance;
      if (
        sample.result?.closureVerified &&
        !sample.result.issues.includes('EXECUTION_NOT_TERMINAL')
      )
        continue;
      if (
        !sample.submissionIntentAt &&
        (stop.signal.aborted ||
          reservedCalls + allowance > options.maxCalls ||
          previousElapsed + Date.now() - invocationStarted >
            options.maxDurationMs)
      )
        continue;
      try {
        await fixtureRequest(options.socketPath, sample.id, {
          scenarioId: scenario.id,
          version: SCENARIO_VERSION,
        });
        sample.submission ??= {
          requestId: sample.id,
          title: `测评 ${scenario.id} ${scenario.title}`,
          cases: [input],
        };
        await save(join(path, 'sample.json'), sample);
        if (!sample.submissionIntentAt) reservedCalls += allowance;
        console.log(
          JSON.stringify({
            event: 'evaluation.start',
            sampleId: sample.id,
            scenario: scenario.id,
          }),
        );
        await executeSample({
          control,
          sample,
          scenario,
          directory: path,
          options,
          stop: stop.signal,
        });
        console.log(
          JSON.stringify({
            event: 'evaluation.result',
            sampleId: sample.id,
            passed: sample.result.passed,
            issues: sample.result.issues,
          }),
        );
        if (
          !sample.result.closureVerified ||
          sample.result.issues.includes('EXECUTION_NOT_TERMINAL')
        )
          stop.abort();
      } catch (error) {
        // 不传播供应商、URL 或凭据错误正文；留下原任务身份供下一次恢复查询。
        sample.error =
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : 'HARNESS_ERROR';
        await save(join(path, 'sample.json'), sample);
        stop.abort();
      }
      manifest.elapsedMs = previousElapsed + Date.now() - invocationStarted;
      manifest.activeSince = new Date().toISOString();
      await save(manifestPath, manifest);
      await save(join(directory, 'summary.json'), summarize(manifest, samples));
    }
    const summary = summarize(manifest, samples);
    manifest.elapsedMs = previousElapsed + Date.now() - invocationStarted;
    manifest.activeSince = null;
    await save(manifestPath, manifest);
    await save(join(directory, 'summary.json'), summary);
    return summary;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await release();
  }
}
