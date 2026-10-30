import type { VerificationCapabilityAssessment } from './verification-capabilities.js';
import { isReleaseIdentity, type ReleaseIdentity } from './release.js';
import { validateBenchmarkRun } from './benchmark-validation.js';
import type { ModelCall } from './generated/model-call.js';
import type { VerificationTask } from './generated/verification-task.js';
import type { VerificationReport } from './generated/verification-report.js';
import type { StepResult } from './generated/step-result.js';

/** 本地协议基准独立版本；场景或门限改变时必须升级，禁止跨版本判定回归。 */
export const BENCHMARK_SUITE = 'agent-loop-basic-v1';
/** 真实模型与 Chrome 的发布套件，不能用脚本模式归档替代。 */
export const REAL_BENCHMARK_SUITE = 'agent-loop-real-v3';
/** 真实站点 V2 任务单独归档；不能替代固定合成场景发布门禁。 */
export const V2_BENCHMARK_SUITE = 'agent-loop-v2-live-v1';
/** 线上 V2 单独版本，不把本地执行端口结果当作部署链路验证。 */
export const DEPLOYED_V2_BENCHMARK_SUITE = 'agent-loop-v2-deployed-v1';
/** 两种 V2 归档共用真实任务页签与正文上限，比较仍区分模式和套件。 */
export function isV2BenchmarkSuite(suite: string): boolean {
  return [V2_BENCHMARK_SUITE, DEPLOYED_V2_BENCHMARK_SUITE].includes(suite);
}
export const REAL_BENCHMARK_CASES = [
  'form-submit',
  'read-only',
  'invalid-target',
  'unknown-write',
  'context-pressure',
  'browser-controls',
  'browser-tabs',
  'browser-disclosures',
  'network-runtime',
  'network-page-return',
] as const;
/** 导入上限同时约束浏览器内存和本地接口响应体。 */
export const BENCHMARK_MAX_BYTES = 20 * 1024 * 1024;
/** 完整历史任务含多步骤和网络原文，仅 V2 归档允许更大的存储体积；执行预算不变。 */
export const V2_BENCHMARK_MAX_BYTES = 64 * 1024 * 1024;
/** 固定模块顺序用于逐轮对比；数值为紧凑 JSON 的 UTF-16 字符数，并非 token。 */
export const CONTEXT_KEYS = [
  'task',
  'state',
  'page',
  'history',
  'evidence',
  'budget',
  'feedback',
] as const;

/** 单条检查记录实际值及明确门限，失败时仍进入归档。 */
export interface BenchmarkCheck {
  /** 稳定的人类可读断言。 */
  name: string;
  /** 判定结果，不等同模型声称的业务通过。 */
  passed: boolean;
  /** 可审阅的实际值和预期值。 */
  detail: string;
}
/** 派发回执独立于模型工具回复；自动观察使用轮次 0 表示首轮之前。 */
export interface BenchmarkCommand {
  /** 多分组执行用调用身份匹配回执；旧归档仍按 decisionIndex 读取。 */
  callId?: string;
  /** V2 步骤内的命令身份，首轮前命令也可归入对应步骤。 */
  stepId?: string;
  /** 当前决策轮次。 */
  decisionIndex: number;
  /** 真正送入执行端口的操作。 */
  operation: Record<string, unknown>;
  /** 控制端口返回的结果与副作用状态。 */
  status: string;
  /** 回执声明的副作用，UNKNOWN 不会被转换为成功。 */
  effect: string;
  /** 真实宿主输出和错误，不含本机截图路径。 */
  result?: Record<string, unknown>;
  error?: string;
  /** 受控故障注入的来源与原始状态，不能当作自然发生的错误。 */
  origin?: string;
  fault?: string;
  nativeStatus?: string;
}
/** 场景记录保留每次 HTTP 请求和执行命令，不能用汇总代替原文。 */
export interface BenchmarkCase {
  /** 历史静态能力评估；仅兼容归档读取，新运行不生成此字段。 */
  preflight?: VerificationCapabilityAssessment;
  /** 通用浏览器任务的实际交付正文与证据，区别于业务验收结论。 */
  browserResult?: VerificationReport['browserResult'];
  /** 真实 V2 历史来源、实际冻结输入和最终逐步报告，不伪造合成站点真值。 */
  verification?: {
    sourceTaskId: string;
    sourceCreatedAt: string;
    sourceDefinitionSha256: string;
    historicalVerdict: string;
    task: VerificationTask;
    steps: StepResult[];
    report: VerificationReport | null;
    sessionClosed: boolean;
  };
  /** 跨运行匹配使用的稳定场景 ID。 */
  id: string;
  /** 控制台标题。 */
  name: string;
  /** 明确夹具验证范围与不覆盖项。 */
  scope: string;
  /** 包含循环编排的本机总耗时。 */
  elapsedMs: number;
  /** 执行器报告的业务结论，可能与基准判定不同。 */
  verdict: string;
  /** 独立断言结果，允许业务未通过但安全停止行为符合预期。 */
  checks: BenchmarkCheck[];
  /** 合并请求开始与结束回执后的原始调用。 */
  calls: ModelCall[];
  /** 含首轮前导航与自动观察的命令序列。 */
  commands: BenchmarkCommand[];
  /** 线上各场景可能由不同 worker 领取，逐例保存实际模型选项以判断比较是否兼容。 */
  modelConfiguration?: BenchmarkRun['modelConfiguration'];
  /** 冻结实际参与此场景的组件身份，节点版本来自会话准入快照。 */
  deployment?: {
    api: ReleaseIdentity | null;
    agent: ReleaseIdentity | null;
    node: Record<string, unknown> | null;
    executionId: string | null;
  };
  /** HTTP 服务独立记录的实际业务事实及宿主关闭结果。 */
  facts?: {
    visits: number;
    writes: Record<string, unknown>[];
    sessionClosed: boolean;
    injected: boolean;
  };
}
/** 可导入控制台的版本化归档，明确区分合成业务与真实站点任务。 */
export interface BenchmarkRun {
  /** 仅用于恢复末尾归档失败的 V2 记录，原始文件保留且失败检查不改写。 */
  archiveRecovery?: {
    recoveredAt: string;
    originalSha256: string;
    reason: string;
  };
  /** 归档结构版本；不兼容结构必须显式升级。 */
  schemaVersion: 1 | 2;
  /** 固定场景集合与门限的版本。 */
  suite: string;
  /** 本次运行唯一身份，不能覆盖历史结果。 */
  id: string;
  /** UTC 开始时间，展示层按本地时区转换。 */
  createdAt: string;
  /** 真实运行完成时间；null 表示尚未完成，不能用于发布。 */
  completedAt?: string | null;
  /** 当前源码身份及工作区是否包含未提交改动。 */
  source: { revision: string; dirty: boolean; fingerprint?: string };
  /** 对比必须使用相同配置；机器耗时只供诊断，不用于性能承诺。 */
  environment: { node: string; platform: string; arch: string };
  /** 实际传入执行器的固定模型与循环预算。 */
  config: { model: string; maxContextChars: number; maxTurns: number };
  /** 明确区分脚本协议回归与真实模型测评。 */
  mode: 'scripted' | 'real' | 'deployed';
  /** v2 归档按发布身份分组；历史 v1 缺失时显示未标版本。 */
  release?: ReleaseIdentity;
  /** 运行位置与模式独立，不能把 CI 隔离基准当成线上链路验收。 */
  origin?: 'local' | 'ci' | 'deployed';
  /** 入队时冻结的目标环境，不能随当前控制台配置变化而改写历史归档。 */
  deploymentEnvironment?: string;
  /** 真实运行必须保存浏览器及引擎身份；预检失败时 ready 为 false。 */
  runtime?: {
    ready: boolean;
    engineVersion: string;
    chromeVersion: string;
    hostSha256: string;
    engineSha256: string;
  };
  /** 不含密钥的模型调用选项；服务地址只保留摘要用于兼容性比较。 */
  modelConfiguration?: {
    vision: boolean;
    tokenParameter: string;
    maxTokens: number;
    thinking: string;
    reasoningEffort: string;
    endpointFingerprint: string;
    modelMs: number;
  };
  /** 完整场景集合，不因失败而删除场景。 */
  cases: BenchmarkCase[];
}

/** 导入不执行原文；结果由检查重算，空场景与重复身份不能得到通过。 */
export function parseBenchmark(text: string): BenchmarkRun {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > V2_BENCHMARK_MAX_BYTES)
    throw new Error('结果文件不能超过 64 MiB');
  const value: unknown = JSON.parse(text);
  if (
    !isV2BenchmarkSuite((value as BenchmarkRun)?.suite) &&
    bytes > BENCHMARK_MAX_BYTES
  )
    throw new Error('基础套件结果文件不能超过 20 MiB');
  if (!validateBenchmarkRun(value))
    throw new Error(
      `不是有效的 Benchmark 结果文件：${validateBenchmarkRun.errors?.[0]?.instancePath} ${validateBenchmarkRun.errors?.[0]?.message}`,
    );
  if (
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Set(value.cases.map((item) => item.id)).size !== value.cases.length
  )
    throw new Error('结果时间无效或场景 ID 重复');
  for (const item of value.cases) {
    if (new Set(item.calls.map((call) => call.id)).size !== item.calls.length)
      throw new Error('模型调用 ID 重复');
  }
  if (value.schemaVersion === 2 && !isReleaseIdentity(value.release))
    throw new Error('缺少有效发布身份');
  for (const item of value.cases)
    if (
      item.deployment &&
      ((item.deployment.api !== null &&
        !isReleaseIdentity(item.deployment.api)) ||
        (item.deployment.agent !== null &&
          !isReleaseIdentity(item.deployment.agent)))
    )
      throw new Error('部署组件身份无效');
  return value;
}

/** 源文解析失败或归档缺失时返回空值，不能补出一份虚假的上下文。 */
function object(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}
function json(value: string | null): Record<string, any> | null {
  try {
    return object(JSON.parse(value ?? 'null'));
  } catch {
    return null;
  }
}

/** 统计实际 user JSON 的七个模块；外层键、逗号与空白单独计数，模块总和严格等于正文长度。 */
export function benchmarkContext(call: Pick<ModelCall, 'request'>) {
  const request = json(call.request);
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const user = messages.find((message: any) => message?.role === 'user');
  const content =
    typeof user?.content === 'string'
      ? user.content
      : Array.isArray(user?.content)
        ? user.content.find((part: any) => part?.type === 'text')?.text
        : undefined;
  const context = typeof content === 'string' ? json(content) : null;
  if (!context || !CONTEXT_KEYS.every((key) => Object.hasOwn(context, key)))
    return null;
  const modules = CONTEXT_KEYS.map((key) => ({
    key,
    chars: JSON.stringify(context[key]).length,
    value: context[key],
  }));
  const total = content.length as number;
  if (total < modules.reduce((sum, part) => sum + part.chars, 0)) return null;
  return {
    context,
    modules,
    // 子项互不重叠，未列出的页面元数据与键名开销保留为余量；旧归档也按实际字段计算。
    pageParts: [
      { key: 'text', label: '正文', fields: ['text'] },
      { key: 'targets', label: '控件', fields: ['targets'] },
      { key: 'network', label: '网络', fields: ['network'] },
      {
        key: 'runtime',
        label: '运行时 / 缓存',
        fields: ['runtime', 'runtimeLists', 'runtimeDetail'],
      },
    ].map(({ key, label, fields }) => ({
      key,
      label,
      chars: fields.reduce(
        (sum, field) =>
          sum +
          (context.page?.[field] === undefined
            ? 0
            : JSON.stringify(context.page[field]).length),
        0,
      ),
    })),
    total,
    envelope: total - modules.reduce((sum, part) => sum + part.chars, 0),
    systemChars: messages
      .filter((message: any) => message?.role === 'system')
      .reduce(
        (sum: number, message: any) =>
          sum +
          (typeof message.content === 'string'
            ? message.content.length
            : JSON.stringify(message.content ?? '').length),
        0,
      ) as number,
    toolsChars: JSON.stringify(request?.tools ?? []).length,
    requestChars: call.request!.length,
  };
}

/** 这里只描述模型提出的工具；是否真正执行必须查 commands 回执。 */
export function benchmarkTools(
  call: Pick<ModelCall, 'response'>,
): { name: string; arguments: string }[] {
  const response = json(call.response);
  const calls = response?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.map((call: any) => ({
    name:
      typeof call?.function?.name === 'string'
        ? call.function.name
        : '未知工具',
    arguments:
      typeof call?.function?.arguments === 'string'
        ? call.function.arguments
        : '',
  }));
}

/** 基础套件固定单工具；V2 沿用正式执行器已有的最多四项纯网络读取批次，禁止携带进度写入。 */
export function benchmarkToolBatchValid(
  call: Pick<ModelCall, 'response'>,
  v2 = false,
): boolean {
  const tools = benchmarkTools(call);
  if (tools.length === 1) return true;
  if (!v2 || tools.length < 2 || tools.length > 4) return false;
  try {
    return tools.every(
      (tool) =>
        ['network_requests', 'network_request_detail'].includes(tool.name) &&
        !JSON.parse(tool.arguments).progress,
    );
  } catch {
    return false;
  }
}

/** 本地检查必须全部通过且有完整轮次；不使用模型报告 PASSED 作为基准门禁。 */
export function benchmarkPassed(item: BenchmarkCase): boolean {
  return (
    item.preflight?.status !== 'BLOCKED' &&
    item.checks.length > 0 &&
    item.checks.every((check) => check.passed) &&
    item.calls.length > 0 &&
    item.calls.every(
      (call) =>
        call.status === 'RECEIVED' &&
        benchmarkContext(call) !== null &&
        benchmarkToolBatchValid(call, !!item.verification),
    )
  );
}

/** 只比较相同套件、模型参数和场景集合；耗时随机器变化，不作为硬门限。 */
export function benchmarkComparison(
  candidate: BenchmarkRun,
  baseline: BenchmarkRun,
): string | null {
  if (candidate.suite !== baseline.suite || candidate.mode !== baseline.mode)
    return '套件版本或运行模式不同';
  if (
    candidate.mode === 'real' &&
    (JSON.stringify(candidate.modelConfiguration) !==
      JSON.stringify(baseline.modelConfiguration) ||
      candidate.runtime?.engineVersion !== baseline.runtime?.engineVersion ||
      candidate.runtime?.chromeVersion !== baseline.runtime?.chromeVersion)
  )
    return '真实模型配置或浏览器版本不同';
  if (
    candidate.config.model !== baseline.config.model ||
    candidate.config.maxContextChars !== baseline.config.maxContextChars ||
    candidate.config.maxTurns !== baseline.config.maxTurns
  )
    return '模型或预算配置不同';
  if (
    candidate.cases
      .map((item) => item.id)
      .sort()
      .join('\n') !==
    baseline.cases
      .map((item) => item.id)
      .sort()
      .join('\n')
  )
    return '场景集合不同';
  if (!baseline.cases.every(benchmarkPassed)) return '基线包含失败或不完整场景';
  if (
    candidate.mode === 'deployed' &&
    candidate.cases.some((item) => {
      const before = baseline.cases.find((entry) => entry.id === item.id)!;
      return (
        !item.modelConfiguration ||
        !before.modelConfiguration ||
        JSON.stringify(item.modelConfiguration) !==
          JSON.stringify(before.modelConfiguration) ||
        item.deployment?.node?.version !== before.deployment?.node?.version ||
        item.deployment?.node?.engineVersion !==
          before.deployment?.node?.engineVersion
      );
    })
  )
    return '线上模型配置或节点版本不同';
  return null;
}

/** 统一汇总口径供 CLI 门禁和看板使用；字符与供应商 token 分开统计，不推算费用。 */
export function benchmarkMetrics(item: BenchmarkCase) {
  return {
    rounds: item.calls.length,
    peakContext: Math.max(
      0,
      ...item.calls.map((call) => benchmarkContext(call)?.total ?? 0),
    ),
    commands: item.commands.length,
  };
}

/** 归档自身的发布条件逐项说明；当前源码与有效期仍由发布端额外核实。 */
export function benchmarkReleaseIssues(run: BenchmarkRun): string[] {
  const issues: string[] = [];
  if (run.mode !== 'real')
    issues.push(
      '需要真实模型 + Chrome 运行，脚本或线上基准不能替代本地发布套件',
    );
  if (run.schemaVersion !== 2) issues.push('归档协议版本不满足发布要求');
  if (run.release?.kind !== 'release')
    issues.push('未指定发布版本，本次仅为开发回归；填写发布版本后重新运行');
  if (!run.release?.commit) issues.push('缺少源码 commit 记录');
  if (run.release?.sourceFingerprint !== run.source.fingerprint)
    issues.push('发布身份与运行源码指纹不一致');
  if (run.suite !== REAL_BENCHMARK_SUITE)
    issues.push('套件不是当前完整基础发布套件');
  if (!run.completedAt || !Number.isFinite(Date.parse(run.completedAt)))
    issues.push('运行尚未完成或完成时间无效');
  if (
    run.runtime?.ready !== true ||
    run.runtime.engineVersion !== 'agent-browser 0.38.1' ||
    !run.runtime.chromeVersion ||
    !/^[a-f0-9]{64}$/.test(run.runtime.hostSha256) ||
    !/^[a-f0-9]{64}$/.test(run.runtime.engineSha256)
  )
    issues.push('真实浏览器运行环境或二进制身份记录不完整');
  if (
    run.cases.length !== REAL_BENCHMARK_CASES.length ||
    !REAL_BENCHMARK_CASES.every((id) =>
      run.cases.some((item) => item.id === id),
    )
  )
    issues.push('基础场景集合不完整');
  if (
    !run.cases.every(
      (item) =>
        !item.verification &&
        benchmarkPassed(item) &&
        item.facts?.sessionClosed === true &&
        item.facts.visits > 0,
    )
  )
    issues.push('场景检查、真实访问或会话关闭记录未全部通过');
  return issues;
}

/** 完整真实套件才能成为发布候选；与逐项原因共用同一判定，避免看板和 CLI 分歧。 */
export function benchmarkReleaseReady(run: BenchmarkRun): boolean {
  return benchmarkReleaseIssues(run).length === 0;
}
