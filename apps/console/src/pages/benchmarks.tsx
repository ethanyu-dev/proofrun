import {
  BenchmarkReleaseConditions,
  benchmarkReleaseStatus,
} from '../components/benchmark-release';
import {
  BenchmarkOutcome,
  benchmarkOutcome,
} from '../components/benchmark-outcome';
import { CapabilityAssessment } from '../components/capability-assessment';
import type { ApiClient } from '../api';
import { useRef, useState } from 'react';
import { Play, Upload, RefreshCw, Download, FlaskConical } from 'lucide-react';
import {
  benchmarkComparison,
  benchmarkContext,
  benchmarkMetrics,
  benchmarkPassed,
  benchmarkTools,
  type BenchmarkCase,
  type BenchmarkRun,
} from '@proofrun/contracts/benchmark';
import { useBenchmarks } from '../use-benchmarks';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { SelectField, SelectItem } from '../components/select-field';
import { ErrorNotice, time } from '../components/ui';
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '../components/ui/tabs';
import {
  BenchmarkContext,
  ContextBar,
  MODULE_LABELS,
} from '../components/benchmark-context';
import '../benchmarks.css';

/** 导出已校验的完整归档，文件名只使用当前时间，不信任导入的 ID 路径。 */
function download(run: BenchmarkRun) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `benchmark-${Date.now()}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** 差值含明确正负号；无兼容基线时不展示虚构的零变化。 */
function delta(current: number, previous: number | undefined) {
  if (previous === undefined) return '—';
  const value = current - previous;
  return `${value > 0 ? '+' : ''}${value.toLocaleString()}`;
}

/** 场景切换重新选择轮次，避免同序号残留上一个场景的上下文。 */
function CaseDetail({
  item,
  pending,
}: {
  item: BenchmarkCase;
  pending: boolean;
}) {
  const [round, setRound] = useState(0);
  const call = item.calls[round];
  const commandsFor = (entry: BenchmarkCase['calls'][number]) =>
    item.commands.filter((command) =>
      command.callId
        ? command.callId === entry.id
        : command.decisionIndex === entry.decisionIndex,
    );
  return (
    <section className="bench-detail" id="benchmark-case-detail">
      <div className="bench-section-title">
        <h2>{item.name}</h2>
        <span className="muted">执行器结论 {item.verdict}</span>
      </div>
      <p className="muted note">{item.scope}</p>
      {!pending && <BenchmarkOutcome item={item} />}
      {item.preflight && <CapabilityAssessment assessment={item.preflight} />}
      {item.verification && (
        <details className="bench-checks">
          <summary>
            原任务 {item.verification.sourceTaskId} ·{' '}
            {item.verification.task.steps?.length ??
              item.verification.steps.length}{' '}
            步 · 已记录 {item.verification.steps.length} 步结果 · 历史{' '}
            {item.verification.historicalVerdict} · 会话
            {(item.preflight?.status === 'BLOCKED' &&
              item.preflight.executionPolicy !== 'skip-steps') ||
            item.verdict === '仅完成能力预检'
              ? '未创建'
              : item.verification.sessionClosed
                ? '已关闭'
                : '未关闭'}
          </summary>
          <div className="bench-step-list">
            {item.verification.steps.map((step) => (
              <div key={step.stepId}>
                <strong>
                  {step.stepId} · {step.status}
                </strong>
                <span className="muted">{step.summary}</span>
              </div>
            ))}
          </div>
          <details>
            <summary>冻结任务、预算与完整报告</summary>
            <pre className="bench-code">
              {JSON.stringify(item.verification, null, 2)}
            </pre>
          </details>
        </details>
      )}
      {item.deployment && (
        <details className="bench-checks">
          <summary>
            实际部署 · API {item.deployment.api?.version ?? '未执行'} · Agent{' '}
            {item.deployment.agent?.version ?? '未领取'} · Node{' '}
            {String(item.deployment.node?.version ?? '未分配')}
          </summary>
          <pre className="bench-code">
            {JSON.stringify(
              {
                ...item.deployment,
                modelConfiguration: item.modelConfiguration,
              },
              null,
              2,
            )}
          </pre>
        </details>
      )}
      {item.browserResult && (
        <details className="bench-checks">
          <summary>浏览器任务交付 · {item.browserResult.outcome}</summary>
          <pre className="bench-code">{item.browserResult.output}</pre>
        </details>
      )}
      {item.facts && (
        <details className="bench-checks">
          <summary>
            服务端事实 · {item.facts.visits} 次访问 · {item.facts.writes.length}{' '}
            次写入 · 会话{item.facts.sessionClosed ? '已关闭' : '未确认关闭'}
          </summary>
          <pre className="bench-code">
            {JSON.stringify(item.facts, null, 2)}
          </pre>
        </details>
      )}
      <details
        className="bench-checks"
        open={!pending && !benchmarkPassed(item)}
      >
        <summary>
          门禁检查 · {item.checks.filter((check) => check.passed).length}/
          {item.checks.length} 通过
        </summary>
        {item.checks.map((check, index) => (
          <div key={index}>
            <span
              className="bench-result"
              data-pass={pending ? undefined : check.passed}
            >
              {pending ? '待核验' : check.passed ? '通过' : '失败'}
            </span>
            <strong>{check.name}</strong>
            <span className="muted">{check.detail}</span>
          </div>
        ))}
      </details>
      <div className="bench-legend">
        {Object.entries(MODULE_LABELS).map(([key, label]) => (
          <span key={key}>
            <i data-module={key} />
            {label}
          </span>
        ))}
        <span>按正文字符占比</span>
      </div>
      <div className="bench-round-layout">
        <div className="bench-rounds" aria-label="决策轮次">
          {item.calls.map((entry, index) => (
            <button
              key={entry.id}
              className="bench-round"
              aria-pressed={index === round}
              onClick={() => setRound(index)}
            >
              <span className="bench-section-title">
                <strong>
                  #{entry.callIndex} {entry.stepId ?? ''}{' '}
                  <small>
                    {String(
                      benchmarkContext(entry)?.context.state?.phase ?? '',
                    )}
                  </small>
                </strong>
                <span className="mono">
                  {benchmarkContext(entry)?.total.toLocaleString() ?? '—'} ch
                </span>
              </span>
              <ContextBar call={entry} />
              <code>
                {benchmarkTools(entry)
                  .map((tool) => tool.name)
                  .join(', ') || entry.status}
              </code>
              <span className="muted note">
                {commandsFor(entry).length} 条派发 · {entry.elapsedMs ?? '—'} ms
              </span>
            </button>
          ))}
          <details className="bench-initial">
            <summary>
              首轮前命令 ·{' '}
              {
                item.commands.filter((command) => command.decisionIndex === 0)
                  .length
              }
            </summary>
            <pre className="bench-code">
              {JSON.stringify(
                item.commands.filter((command) => command.decisionIndex === 0),
                null,
                2,
              )}
            </pre>
          </details>
        </div>
        {call ? (
          <BenchmarkContext
            key={call.id}
            call={call}
            commands={commandsFor(call)}
          />
        ) : (
          <p className="muted">
            {pending
              ? '等待 Agent 执行并记录模型调用。'
              : item.preflight?.status === 'BLOCKED' &&
                  item.preflight.executionPolicy !== 'skip-steps'
                ? '能力预检已阻塞任务，没有模型 context 或工具调用。'
                : item.verdict === '仅完成能力预检'
                  ? '本次仅评估定义，未执行模型或浏览器验证。'
                  : '未生成模型调用，请检查失败原因。'}
          </p>
        )}
      </div>
    </section>
  );
}

/** 两个测试集均可选择线上调度；本地开发执行与导入归档保持独立数据源。 */
export function BenchmarksPage({ api }: { api: ApiClient | null }) {
  const [source, setSource] = useState(api ? 'server' : 'local');
  const [family, setFamily] = useState<'browser' | 'v2'>('browser');
  return (
    <>
      <Tabs
        value={family}
        onValueChange={(value) => setFamily(value as 'browser' | 'v2')}
      >
        <TabsList variant="line" aria-label="Benchmark 测试集">
          <TabsTrigger value="browser">浏览器任务</TabsTrigger>
          <TabsTrigger value="v2">V2 真实任务</TabsTrigger>
        </TabsList>
        <TabsContent value={family}>
          <div className="bench-toolbar bench-source">
            <SelectField
              label="结果来源"
              value={source}
              onValueChange={setSource}
            >
              <SelectItem value="local">本地运行 / 导入归档</SelectItem>
              {api && <SelectItem value="server">线上调度与存储</SelectItem>}
            </SelectField>
            {!api && <a href="#/tasks">连接控制台以使用线上基准</a>}
          </div>
          <BenchmarkWorkspace
            key={`${source}-${family}`}
            family={family}
            api={source === 'server' ? api : null}
          />
        </TabsContent>
      </Tabs>
    </>
  );
}
/** 数据源切换重建状态，防止本地文件与线上运行身份串用。 */
function BenchmarkWorkspace({
  api,
  family,
}: {
  api: ApiClient | null;
  family: 'browser' | 'v2';
}) {
  const state = useBenchmarks(api ?? undefined, family);
  const live = family === 'v2';
  const [releaseVersion, setReleaseVersion] = useState('');
  const [caseId, setCaseId] = useState('');
  const [mode, setMode] = useState<'real' | 'scripted'>('real');
  const [baselineId, setBaselineId] = useState('none');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const input = useRef<HTMLInputElement>(null);
  const run =
    state.runs.find(
      (entry) =>
        entry.id === state.selected &&
        (state.version === 'all' ||
          (entry.release?.version ?? 'unversioned') === state.version),
    ) ?? state.runs.find((entry) => entry.id === state.entries[0]?.id);
  const baseline = state.runs.find((entry) => entry.id === baselineId);
  const mismatch = run && baseline ? benchmarkComparison(run, baseline) : null;
  const compatible =
    baseline && !mismatch && baseline.id !== run?.id ? baseline : undefined;
  const pending = run?.mode === 'deployed' && !run.completedAt;
  const visible =
    run?.cases.filter(
      (item) =>
        `${item.id} ${item.name}`.toLowerCase().includes(query.toLowerCase()) &&
        (filter === 'all' ||
          (pending
            ? filter === 'pending'
            : filter !== 'pending' &&
              benchmarkPassed(item) === (filter === 'passed'))),
    ) ?? [];
  const selected = visible.find((item) => item.id === caseId) ?? visible[0];
  const passed = run?.cases.filter(benchmarkPassed).length ?? 0;
  return (
    <div className="bench-page">
      <header className="bench-header">
        <div>
          <h1>
            <FlaskConical size={22} />
            Agent Loop Benchmark
          </h1>
          <p className="muted">
            {live ? 'V2 真实任务 · 完整步骤与原预算' : '基础场景回归'} ·
            逐轮上下文 · 工具调用
          </p>
        </div>
        <div className="bench-actions">
          <input
            ref={input}
            type="file"
            accept=".json,application/json"
            multiple
            className="sr-only"
            aria-label="导入 Benchmark 结果"
            onChange={(event) => {
              void state.importFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!!api}
            onClick={() => input.current?.click()}
          >
            <Upload size={14} />
            导入结果
          </Button>
          {run && (
            <Button variant="outline" size="sm" onClick={() => download(run)}>
              <Download size={14} />
              导出
            </Button>
          )}
          {(api || import.meta.env.DEV) && (
            <>
              <Button
                variant="outline"
                size="sm"
                aria-label="刷新结果"
                disabled={state.loading}
                onClick={() => void state.refresh()}
              >
                <RefreshCw size={14} />
              </Button>
              {!api && (
                <Input
                  aria-label="本次发布版本"
                  placeholder="版本（留空为开发运行）"
                  value={releaseVersion}
                  onChange={(event) => setReleaseVersion(event.target.value)}
                  className="bench-version-input"
                />
              )}
              {!api && !live && (
                <SelectField
                  label="运行模式"
                  value={mode}
                  onValueChange={(value) =>
                    setMode(value as 'real' | 'scripted')
                  }
                >
                  <SelectItem value="real">真实模型 + Chrome</SelectItem>
                  <SelectItem value="scripted">脚本协议回归</SelectItem>
                </SelectField>
              )}
              <Button
                size="sm"
                disabled={state.running || (!!api && !state.server?.enabled)}
                onClick={() =>
                  void state.start(mode, releaseVersion.trim() || undefined)
                }
              >
                <Play size={14} />
                {state.running
                  ? '运行中…'
                  : api
                    ? live
                      ? '开始 V2 测试'
                      : '发起线上基准'
                    : mode === 'real'
                      ? '运行真实基准'
                      : '运行协议回归'}
              </Button>
            </>
          )}
        </div>
      </header>
      <ErrorNotice message={state.error} />
      <div className="bench-notice">
        {live
          ? `真实模型访问历史任务指定的生产站点，保留原始验收标准、步骤预算和来源任务。${api ? `由后台调度 Agent 与浏览器节点，离开页面后继续；目标环境：${state.server?.environment ?? '读取中'}；API 版本：${state.server?.release.version ?? '未记录'}。` : '由本地独立 Chrome 执行。'}`
          : api
            ? `目标环境：${state.server?.environment ?? '读取中'}；实际 API 版本：${state.server?.release.version ?? '未记录'}。由后台队列调度实际 Agent 和浏览器节点。`
            : run?.mode === 'scripted'
              ? '当前为脚本协议回归，不能代替真实发布检查。'
              : '真实模型 + 独立 Chrome · 本地合成业务 · 固定十场景，包含网络 context、通用浏览器任务及两项明确故障注入。'}
        {!api && !live && (
          <>
            发布要求完整真实运行通过、24 小时内且源码指纹一致。
            <code>
              pnpm benchmark:release --version vX.Y.Z --env-file
              .proofrun/local.env
            </code>
          </>
        )}
        {api && !state.server?.enabled && (
          <span>服务端需配置基准节点池、环境与正式构建清单后启用。</span>
        )}
      </div>
      {state.running && (
        <p role="status" className="bench-notice">
          {state.activeFamily && state.activeFamily !== family
            ? `正在运行另一个测试集：${state.activeFamily === 'v2' ? 'V2 真实任务' : '浏览器任务'}。请切换对应页签查看结果。`
            : api
              ? '后台存在排队或执行中的基准，离开页面后继续运行。'
              : live
                ? '正在运行两项完整 V2 任务；结束后读取逐步结果与完整调用归档。'
                : '正在构建并运行全部基础场景，完成后自动读取结果。'}
        </p>
      )}
      {state.log && (
        <details className="bench-log">
          <summary>最近运行日志</summary>
          <pre className="bench-code">{state.log}</pre>
        </details>
      )}
      <div className="bench-toolbar">
        <label>
          <span>发布版本</span>
          <SelectField
            label="发布版本"
            value={state.version}
            onValueChange={state.setVersion}
          >
            <SelectItem value="all">全部版本</SelectItem>
            {state.versions.map((version) => (
              <SelectItem key={version} value={version}>
                {version === 'unversioned' ? '历史未标版本' : version}
              </SelectItem>
            ))}
          </SelectField>
        </label>
        <label>
          <span>每次运行</span>
          <SelectField
            label="当前运行"
            value={state.selected || state.entries[0]?.id || 'none'}
            onValueChange={(value) => {
              state.setSelected(value);
              setCaseId('');
              if (value === baselineId) setBaselineId('none');
            }}
          >
            {!state.entries.length && (
              <SelectItem value="none">暂无运行</SelectItem>
            )}
            {state.entries.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                {entry.release?.version ?? '历史未标版本'} ·{' '}
                {time(entry.createdAt)} · {entry.state ?? entry.id.slice(0, 8)}
              </SelectItem>
            ))}
          </SelectField>
        </label>
        {state.nextCursor && (
          <Button size="sm" variant="outline" onClick={() => void state.more()}>
            更早运行
          </Button>
        )}
      </div>
      {!run ? (
        <section className="bench-empty">
          <FlaskConical size={30} />
          <h2>{state.loading ? '正在读取结果…' : '开始第一轮基准测试'}</h2>
          <p className="muted">
            {api
              ? live
                ? '由后台发起两项完整历史 V2 任务，结果持续保存在数据库。'
                : '由后台发起固定五场景，结果持续保存在数据库。'
              : live
                ? '运行已冻结的两项历史任务，或导入对应 V2 归档。'
                : '运行基础场景，或导入 CI / 本地生成的结果 JSON。'}
          </p>
          {!api && (
            <code>
              {live
                ? 'pnpm benchmark:v2 --env-file .proofrun/local.env'
                : 'pnpm benchmark:agent'}
            </code>
          )}
          <p className="muted note">
            每次运行包含检查、每轮上下文、模型请求及工具回执。
          </p>
        </section>
      ) : (
        <>
          <div className="bench-toolbar">
            <label>
              <span>对比基线</span>
              <SelectField
                label="对比基线"
                value={baselineId}
                onValueChange={(value) => {
                  setBaselineId(value);
                  if (value !== 'none') void state.load(value);
                }}
              >
                <SelectItem value="none">不对比</SelectItem>
                {state.entries
                  .filter((entry) => entry.id !== run.id)
                  .map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.release?.version ?? '历史未标版本'} ·{' '}
                      {time(entry.createdAt)}
                    </SelectItem>
                  ))}
              </SelectField>
            </label>
            <span className="bench-meta mono">
              {run.release?.version ?? '历史未标版本'} ·{' '}
              {run.release?.buildId ?? '无构建身份'}
              <br />
              {run.suite}
              {run.deploymentEnvironment
                ? ` · ${run.deploymentEnvironment}`
                : ''}
              <br />
              {run.environment.platform}/{run.environment.arch} · Node{' '}
              {run.environment.node}
              <br />
              {run.config.model}
              {run.runtime?.ready
                ? ` · ${run.runtime.engineVersion} · ${run.runtime.chromeVersion}`
                : ''}
            </span>
          </div>
          {mismatch && (
            <p className="bench-notice" role="status">
              无法比较：{mismatch}。原始结果仍可查看。
            </p>
          )}
          {run.archiveRecovery && (
            <p className="bench-notice">
              归档恢复：{run.archiveRecovery.reason} 原文件摘要{' '}
              {run.archiveRecovery.originalSha256.slice(0, 12)}
              ；执行检查与失败结论保持原样。
            </p>
          )}
          {!live && run.mode !== 'deployed' && (
            <BenchmarkReleaseConditions run={run} />
          )}
          <div className="bench-stats">
            <div>
              <span>
                {live
                  ? 'V2 真实任务'
                  : run.mode === 'deployed'
                    ? '线上基准'
                    : run.release?.kind === 'development'
                      ? '开发基准'
                      : '真实发布候选'}
              </span>
              <strong
                className="bench-result"
                data-pass={
                  live
                    ? !!run.completedAt && passed === run.cases.length
                    : run.mode === 'deployed'
                      ? !!run.completedAt && passed === run.cases.length
                      : benchmarkReleaseStatus(run).passed
                }
              >
                {live
                  ? !run.completedAt
                    ? '等待完成'
                    : passed === run.cases.length
                      ? '通过'
                      : '未通过'
                  : run.mode === 'deployed'
                    ? !run.completedAt
                      ? '等待完成'
                      : passed === run.cases.length
                        ? '通过'
                        : '未通过'
                    : benchmarkReleaseStatus(run).label}
              </strong>
            </div>
            <div>
              <span>{live ? '真实任务' : '基础场景'}</span>
              <strong>
                {passed}
                <small> / {run.cases.length} 通过</small>
              </strong>
            </div>
            <div>
              <span>模型轮次</span>
              <strong>
                {run.cases.reduce((sum, item) => sum + item.calls.length, 0)}
              </strong>
            </div>
            <div>
              <span>Context 峰值</span>
              <strong>
                {Math.max(
                  ...run.cases.map(
                    (item) => benchmarkMetrics(item).peakContext,
                  ),
                ).toLocaleString()}
                <small> 字符</small>
              </strong>
            </div>
            <div>
              <span>
                {run.mode === 'deployed'
                  ? '场景总耗时（含排队）'
                  : '场景总耗时'}
              </span>
              <strong>
                {(
                  run.cases.reduce((sum, item) => sum + item.elapsedMs, 0) /
                  1000
                ).toFixed(2)}
                <small> s</small>
              </strong>
            </div>
          </div>
          <section className="bench-cases">
            <div className="bench-section-title">
              <h2>
                {live ? '历史真实任务' : '浏览器场景'}{' '}
                <span className="muted">{visible.length}</span>
              </h2>
              <div className="bench-filters">
                <Input
                  aria-label="搜索场景"
                  placeholder="搜索场景…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <SelectField
                  label="场景检查状态"
                  value={filter}
                  onValueChange={setFilter}
                >
                  <SelectItem value="all">全部状态</SelectItem>
                  <SelectItem value="passed">通过</SelectItem>
                  <SelectItem value="failed">未通过 / 未启动</SelectItem>
                  <SelectItem value="pending">待核验</SelectItem>
                </SelectField>
              </div>
            </div>
            <div className="bench-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>场景</th>
                    <th>门禁</th>
                    <th>轮次 / Δ</th>
                    <th>Context 峰值 / Δ</th>
                    <th>派发命令</th>
                    <th>耗时</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((item) => {
                    const metrics = benchmarkMetrics(item);
                    const before = compatible?.cases.find(
                      (entry) => entry.id === item.id,
                    );
                    const old = before ? benchmarkMetrics(before) : undefined;
                    return (
                      <tr
                        key={item.id}
                        data-selected={item.id === selected?.id}
                      >
                        <td>
                          <button
                            className="bench-case-link"
                            onClick={() => {
                              setCaseId(item.id);
                              requestAnimationFrame(() =>
                                document
                                  .getElementById('benchmark-case-detail')
                                  ?.scrollIntoView({
                                    block: 'start',
                                    behavior: 'smooth',
                                  }),
                              );
                            }}
                            aria-pressed={item.id === selected?.id}
                          >
                            {item.name}
                            <small className="muted mono">{item.id}</small>
                          </button>
                          {!pending && (
                            <p className="bench-case-reason">
                              {benchmarkOutcome(item).summary}
                            </p>
                          )}
                        </td>
                        <td>
                          <span
                            className="bench-result"
                            data-pass={
                              pending ? undefined : benchmarkPassed(item)
                            }
                          >
                            {pending ? '待核验' : benchmarkOutcome(item).label}
                          </span>
                        </td>
                        <td className="mono">
                          {metrics.rounds}
                          <small>{delta(metrics.rounds, old?.rounds)}</small>
                        </td>
                        <td className="mono">
                          {metrics.peakContext.toLocaleString()}
                          <small>
                            {delta(metrics.peakContext, old?.peakContext)}
                          </small>
                        </td>
                        <td>{metrics.commands}</td>
                        <td className="mono">{item.elapsedMs} ms</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!visible.length && (
              <p className="bench-notice">没有匹配的场景，请调整筛选。</p>
            )}
          </section>
          {selected && (
            <CaseDetail
              key={`${run.id}-${selected.id}`}
              item={selected}
              pending={pending}
            />
          )}
          <p className="muted note">
            当前提交 {run.source.revision}
            {run.source.dirty ? '（包含未提交改动）' : ''} · 运行 {run.id}
            。导入文件只供复盘，发布以 CI 当前提交重新运行的退出码为准。
          </p>
        </>
      )}
    </div>
  );
}
