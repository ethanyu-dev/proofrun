import { randomUUID } from 'node:crypto';
import { validateControlRequest } from '@proofrun/contracts';

/** 固定已核对的版本，避免 jev-latest 别名延迟切换或后续静默升级。 */
export const DEFAULT_JEV_MODEL = 'jev-1.14.0';

/** 新执行默认使用统一计划；legacy 仅供显式回退。 */
const DEFAULT_EXECUTION_POLICY = 'planned-v1';

/** 思考输出与工具参数共享额度；显式长推理仍有上限，默认成本配置保持独立。 */
const MODEL_LIMITS = { timeoutMs: 600_000, outputTokens: 65_536 };

/** 默认限制约束单 worker 的成本；任务预算和控制面租约仍是更硬的边界。 */
const DEFAULTS = {
  pollMs: 1000,
  requestMs: 5000,
  modelMs: 30_000,
  commandMs: 15_000,
  // 覆盖节点 20 秒上传及重试等待，不与浏览器命令共用时限。
  evidenceMs: 60_000,
  maxTurns: 40,
  maxContextChars: 64_000,
  maxTokens: 4096,
};

/** 一个进程只执行一个任务，并发通过多个 worker 实例实现。 */
export interface AgentConfig {
  /** 控制面地址与领取凭据；不会进入模型提示。 */
  apiUrl: string;
  workerToken: string;
  /** 本次进程身份，不复用失去租约的执行。 */
  workerId: string;
  /** 模型服务独立配置，模型名不设默认值。 */
  modelUrl: string;
  modelKey: string;
  model: string;
  /** 是否向模型发送已核实摘要的截图；纯文本模型保持 false。 */
  vision: boolean;
  /** 显式允许 Jev 扩展文本预算；实验请求头只在估算超过默认 token 预算时发送。 */
  jevLongContext?: boolean;
  /** JEV 独立接收当前截图，不要求文本审查模型支持图片。 */
  jevImages?: boolean;
  /** 按操作分组候选并开放已声明的额外动作，关闭时保留旧选择策略。 */
  jevExpandedActions?: boolean;
  /** 允许实验 Box 定位；必须同时开启 JEV 图片输入。 */
  jevBox?: boolean;
  /** 通用子目标、进度和定位策略，显式灰度启用。 */
  executionGuidance?: boolean;
  /** 执行创建时冻结；legacy 保留原流程，planned-v1 使用统一计划与路由。 */
  executionPolicy?: 'legacy' | 'planned-v1';
  /** 不同 Chat Completions 服务使用的输出预算参数。 */
  tokenParameter: 'max_tokens' | 'max_completion_tokens';
  /** 未设置时沿用供应商默认；显式模式仅传给配置的 Chat Completions 服务。 */
  thinking?: 'enabled' | 'disabled';
  /** 显式推理强度；不设置时不覆盖供应商默认，也不影响 TypeSafe 候选模型。 */
  reasoningEffort?: 'low' | 'high' | 'max';
  /** 空队列轮询、单 HTTP 请求、模型调用和浏览器命令的时限。 */
  pollMs: number;
  requestMs: number;
  modelMs: number;
  commandMs: number;
  /** 命令成功后等待证据持久化及可用回执的独立时限，仍受任务和租约约束。 */
  evidenceMs: number;
  /** 决策次数、文本上下文和单次模型输出的上限。 */
  maxTurns: number;
  maxContextChars: number;
  maxTokens: number;
}

/** 拒绝非整数与失控上限，避免配置拼写错误变成无限循环。 */
function number(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`);
  return value;
}
/** 仅接受明确的 HTTP 服务地址，不从页面或模型结果选择模型服务。 */
function endpoint(name: string, fallback?: string): string {
  const url = new URL(process.env[name] ?? fallback ?? '');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(`Invalid ${name}`);
  return url.toString().replace(/\/$/, '');
}
/** 启动时核实配置，不扫描磁盘寻找其他项目的密钥。 */
export function loadConfig(): AgentConfig {
  const executionPolicy =
    process.env.PROOFRUN_AGENT_EXECUTION_POLICY ?? DEFAULT_EXECUTION_POLICY;
  if (!['legacy', 'planned-v1'].includes(executionPolicy))
    throw new Error(
      'PROOFRUN_AGENT_EXECUTION_POLICY must be legacy or planned-v1',
    );
  const workerToken = process.env.PROOFRUN_WORKER_TOKEN ?? '';
  const modelKey = process.env.PROOFRUN_MODEL_API_KEY ?? '';
  const model = process.env.PROOFRUN_MODEL ?? '';
  const workerId = process.env.PROOFRUN_WORKER_ID ?? randomUUID();
  if (!validateControlRequest({ type: 'worker.claim', workerId }))
    throw new Error('Invalid PROOFRUN_WORKER_ID');
  const tokenParameter =
    process.env.PROOFRUN_MODEL_TOKEN_PARAMETER ?? 'max_completion_tokens';
  if (
    workerToken.length < 32 ||
    !modelKey ||
    !model ||
    !['max_tokens', 'max_completion_tokens'].includes(tokenParameter)
  )
    throw new Error(
      'Configure worker credential, model endpoint, model name and model API key',
    );
  const thinking = process.env.PROOFRUN_MODEL_THINKING ?? 'default';
  if (
    thinking !== 'default' &&
    thinking !== 'enabled' &&
    thinking !== 'disabled'
  )
    throw new Error(
      'PROOFRUN_MODEL_THINKING must be default, enabled or disabled',
    );
  const reasoningEffort =
    process.env.PROOFRUN_MODEL_REASONING_EFFORT ?? 'default';
  if (!['default', 'low', 'high', 'max'].includes(reasoningEffort))
    throw new Error(
      'PROOFRUN_MODEL_REASONING_EFFORT must be default, low, high or max',
    );
  const vision = process.env.PROOFRUN_MODEL_VISION ?? 'false';
  if (!['true', 'false'].includes(vision))
    throw new Error('PROOFRUN_MODEL_VISION must be true or false');
  const jevLongContext = process.env.PROOFRUN_JEV_LONG_CONTEXT ?? 'false';
  if (!['true', 'false'].includes(jevLongContext))
    throw new Error('PROOFRUN_JEV_LONG_CONTEXT must be true or false');
  const jevImages = boolean('PROOFRUN_JEV_IMAGES');
  const jevBox = boolean('PROOFRUN_JEV_BOX');
  if (jevBox && !jevImages)
    throw new Error('PROOFRUN_JEV_BOX requires PROOFRUN_JEV_IMAGES=true');
  return {
    executionPolicy: executionPolicy as NonNullable<
      AgentConfig['executionPolicy']
    >,
    executionGuidance:
      boolean('PROOFRUN_AGENT_EXECUTION_GUIDANCE') ||
      executionPolicy === 'planned-v1',
    jevImages,
    jevBox,
    jevExpandedActions: boolean('PROOFRUN_JEV_EXPANDED_ACTIONS'),
    jevLongContext: jevLongContext === 'true',
    apiUrl: endpoint('PROOFRUN_CONTROL_URL', 'http://127.0.0.1:4100'),
    workerToken,
    workerId,
    modelUrl: endpoint('PROOFRUN_MODEL_BASE_URL'),
    modelKey,
    model,
    vision: vision === 'true',
    ...(thinking === 'default' ? {} : { thinking }),
    ...(reasoningEffort === 'default'
      ? {}
      : {
          reasoningEffort: reasoningEffort as NonNullable<
            AgentConfig['reasoningEffort']
          >,
        }),
    tokenParameter: tokenParameter as AgentConfig['tokenParameter'],
    pollMs: number('PROOFRUN_AGENT_POLL_MS', DEFAULTS.pollMs, 100, 30_000),
    requestMs: number(
      'PROOFRUN_AGENT_HTTP_MS',
      DEFAULTS.requestMs,
      100,
      10_000,
    ),
    modelMs: number(
      'PROOFRUN_AGENT_MODEL_MS',
      DEFAULTS.modelMs,
      100,
      MODEL_LIMITS.timeoutMs,
    ),
    commandMs: number(
      'PROOFRUN_AGENT_COMMAND_MS',
      DEFAULTS.commandMs,
      100,
      120_000,
    ),
    evidenceMs: number(
      'PROOFRUN_AGENT_EVIDENCE_MS',
      DEFAULTS.evidenceMs,
      100,
      300_000,
    ),
    maxTurns: number('PROOFRUN_AGENT_MAX_TURNS', DEFAULTS.maxTurns, 1, 200),
    maxContextChars: number(
      'PROOFRUN_AGENT_CONTEXT_CHARS',
      DEFAULTS.maxContextChars,
      4000,
      256_000,
    ),
    maxTokens: number(
      'PROOFRUN_MODEL_MAX_TOKENS',
      DEFAULTS.maxTokens,
      256,
      MODEL_LIMITS.outputTokens,
    ),
  };
}

/** 实验能力只能显式开启，拼写错误不能静默采用默认值。 */
function boolean(name: string): boolean {
  const value = process.env[name] ?? 'false';
  if (!['true', 'false'].includes(value))
    throw new Error(`${name} must be true or false`);
  return value === 'true';
}
