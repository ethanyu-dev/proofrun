import {
  basicInteractionObjective,
  basicInteractionChecks,
} from '@proofrun/contracts/benchmark-interactions';
import type { Database } from '../../db.js';
import {
  DEPLOYED_V2_BENCHMARK_SUITE,
  benchmarkContext,
  benchmarkTools,
  parseBenchmark,
  type BenchmarkRun,
  type BenchmarkCase,
} from '@proofrun/contracts/benchmark';
import {
  BENCHMARK_SCENARIOS,
  BENCHMARK_LIMITS,
  V2_CONTEXT_CHARS,
  v2CallLimit,
  DEPLOYED_BENCHMARK_SUITE,
  LEGACY_DEPLOYED_BENCHMARK_SUITE,
} from '@proofrun/contracts/benchmark-scenarios';
import { canonical } from '../../domain.js';
import { archiveV2Checks } from './v2-archive.js';

/** 从持久化事实投影归档，终态保存一次；尚未完成的场景不能借模型结论变成通过。 */
export async function benchmarkArchive(
  db: Database,
  job: any,
  complete: boolean,
): Promise<BenchmarkRun> {
  const rows = (
    await db.query(
      `SELECT b.*,t.state,t.report,t.error,t.definition,t.step_results,t.created_at,t.finished_at,e.id AS execution_id,s.node_runtime,s.closure_verified FROM pr_benchmark_cases b JOIN pr_tasks t ON t.id=b.task_id LEFT JOIN pr_executions e ON e.task_id=t.id LEFT JOIN pr_sessions s ON s.execution_id=e.id WHERE b.run_id=$1`,
      [job.id],
    )
  ).rows;
  const v2 = job.family === 'v2';
  const modelNames = [
    ...new Set(rows.map((row) => row.model_config?.name).filter(Boolean)),
  ].sort();
  const run: BenchmarkRun = {
    schemaVersion: 2,
    suite: v2 ? DEPLOYED_V2_BENCHMARK_SUITE : job.suite,
    id: job.id,
    createdAt: job.created_at.toISOString(),
    completedAt: complete ? new Date().toISOString() : null,
    release: job.release,
    origin: 'deployed',
    deploymentEnvironment: job.environment,
    mode: 'deployed',
    source: {
      revision: job.release.commit ?? 'unversioned',
      dirty: false,
      ...(job.release.sourceFingerprint
        ? { fingerprint: job.release.sourceFingerprint }
        : {}),
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    config: {
      model: modelNames.join(' / ') || '等待 Agent',
      maxTurns: v2
        ? Math.max(...rows.map((row) => v2CallLimit(row.definition)))
        : BENCHMARK_LIMITS.maxTurns,
      maxContextChars: v2 ? V2_CONTEXT_CHARS : BENCHMARK_LIMITS.maxContextChars,
    },
    cases: [],
  };
  const scenarios = v2
    ? rows.map((row) => row.source).sort((a, b) => a.id.localeCompare(b.id))
    : job.suite === LEGACY_DEPLOYED_BENCHMARK_SUITE
      ? BENCHMARK_SCENARIOS.slice(0, 5)
      : BENCHMARK_SCENARIOS;
  if (
    !v2 &&
    ![LEGACY_DEPLOYED_BENCHMARK_SUITE, DEPLOYED_BENCHMARK_SUITE].includes(
      job.suite,
    )
  )
    throw new Error('未知基础验证套件');
  for (const scenario of scenarios) {
    const row = rows.find((entry) => entry.scenario === scenario.id);
    if (!row) throw new Error('持久化基准场景缺失');
    const calls = row.execution_id
      ? (
          await db.query(
            'SELECT record FROM pr_model_calls WHERE execution_id=$1 ORDER BY call_index',
            [row.execution_id],
          )
        ).rows.map((entry) => entry.record)
      : [];
    const commands = (
      await db.query(
        'SELECT record FROM pr_benchmark_commands WHERE task_id=$1 ORDER BY created_at,command_id',
        [row.task_id],
      )
    ).rows.map((entry) => entry.record);
    const item: BenchmarkCase = {
      id: scenario.id,
      name: scenario.name,
      scope: v2
        ? '线上 API → 实际 Agent → 浏览器节点；完整历史 V2 定义与原预算，访问真实生产站点。站点变化及缺失能力如实记录，不替代基础发布套件。'
        : '线上 API → 实际 Agent → 浏览器节点；独立访客会话和合成页面。旧观察及丢回执是明确故障注入，不覆盖生产账号和实际业务站点。',
      elapsedMs: Math.max(
        0,
        (row.finished_at?.getTime() ?? Date.now()) - row.created_at.getTime(),
      ),
      verdict:
        row.report?.browserResult?.outcome ??
        row.report?.verdict ??
        row.error?.code ??
        row.state,
      ...(row.report?.browserResult
        ? { browserResult: row.report.browserResult }
        : {}),
      checks: [],
      calls,
      commands,
      ...(row.model_config
        ? {
            modelConfiguration: {
              vision: row.model_config.vision,
              tokenParameter: row.model_config.tokenParameter,
              maxTokens: row.model_config.maxTokens,
              thinking: row.model_config.thinking,
              reasoningEffort: row.model_config.reasoningEffort,
              endpointFingerprint: row.model_config.endpointFingerprint,
              modelMs: row.model_config.modelMs,
            },
          }
        : {}),
      ...(v2
        ? {}
        : {
            facts: {
              visits: row.visits,
              writes: row.writes,
              sessionClosed: row.closure_verified === true,
              injected: row.injected,
            },
          }),
      deployment: {
        api: row.api_release,
        agent: row.agent_release,
        node: row.node_runtime,
        executionId: row.execution_id,
      },
    };
    const check = (name: string, passed: boolean, detail: string) =>
      item.checks.push({ name, passed, detail });
    check(
      '执行结束并核实会话关闭',
      !['QUEUED', 'RUNNING'].includes(row.state) &&
        row.closure_verified === true,
      `${row.state}；会话关闭 ${row.closure_verified === true}`,
    );
    const identity =
      row.api_release &&
      canonical(row.api_release) === canonical(job.release) &&
      row.agent_release?.kind === 'release' &&
      row.agent_release.version === job.release.version &&
      row.agent_release.sourceFingerprint === job.release.sourceFingerprint &&
      row.node_runtime?.version &&
      row.node_runtime?.sourceCommit;
    check(
      '实际部署版本可追溯且未漂移',
      !!identity,
      `API ${row.api_release?.version ?? '未记录'}；Agent ${row.agent_release?.version ?? '未记录'}；Node ${row.node_runtime?.version ?? '未记录'}`,
    );
    if (v2) {
      archiveV2Checks(item, row);
      run.cases.push(item);
      continue;
    }
    const interaction = basicInteractionObjective(scenario.id);
    if (interaction)
      item.checks.push(
        ...basicInteractionChecks(scenario.id, row.report, commands, {
          visits: row.visits,
          writes: row.writes,
        }),
      );
    const readOnly = scenario.id === 'read-only';
    const writesCorrect =
      canonical(row.writes) ===
      canonical(readOnly ? [] : [{ name: 'Alice', city: 'Hangzhou' }]);
    const resultCorrect =
      scenario.id === 'unknown-write'
        ? row.injected && !!row.report && row.report.verdict !== 'PASSED'
        : row.report?.verdict === 'PASSED';
    const readonlyCorrect =
      !readOnly ||
      !commands.some(
        (command) =>
          command.operation.type === 'browser.act' &&
          command.operation.action !== 'navigate',
      );
    if (!interaction)
      check(
        '真实业务事实与副作用',
        row.visits > 0 && writesCorrect && resultCorrect && readonlyCorrect,
        `访问 ${row.visits} 次；写入 ${row.writes.length} 次；结论 ${item.verdict}`,
      );
    const malformed = calls.find(
      (call) =>
        call.status !== 'RECEIVED' ||
        benchmarkTools(call).length !== 1 ||
        !benchmarkContext(call) ||
        benchmarkContext(call)!.total > BENCHMARK_LIMITS.maxContextChars,
    );
    check(
      '完整逐轮记录与固定预算',
      calls.length > 0 &&
        calls.length <= BENCHMARK_LIMITS.maxTurns &&
        !malformed,
      malformed
        ? `轮次 ${malformed.decisionIndex} 状态 ${malformed.status}、工具 ${benchmarkTools(malformed).length} 个；要求完整回执、单工具和上下文 ≤ 12000 字符`
        : `${calls.length} / ${BENCHMARK_LIMITS.maxTurns} 轮`,
    );
    if (scenario.id === 'invalid-target')
      check(
        '旧观察真实拒绝并反馈',
        row.injected &&
          row.stale_rejected &&
          calls.some(
            (call) => benchmarkContext(call)?.context.feedback?.length,
          ),
        '故障必须确实触发，保留实际宿主拒绝和下一轮反馈',
      );
    if (scenario.id === 'context-pressure')
      check(
        '长页面实际裁剪',
        calls.some(
          (call) =>
            benchmarkContext(call)?.context.page?.coverage?.text?.truncated,
        ),
        '必须实际触发正文裁剪',
      );
    run.cases.push(item);
  }
  return parseBenchmark(JSON.stringify(run));
}
