import type { VerificationReport, VerificationTask } from '@proofrun/contracts';
import type { BrowserOperation } from '../client.js';
import type { Observation } from '../evidence/observation.js';
import type { ObservationChanges } from '../evidence/changes.js';
import type { DecisionInput } from '../model/chat.js';
import { evidenceExcerpt } from '../model/jev-progress.js';
import { AgentFault } from '../http.js';
import type { WorkflowView } from './workflow.js';

/** 只发送近期证据摘要，完整证据仍由执行器和控制面保存。 */
const EVIDENCE_LIMIT = 24;
/** 跨栏目只保留最近页面的有界正文，不能复用历史元素身份。 */
const OBSERVATION_HISTORY_LIMIT = 8;
const OBSERVATION_HISTORY_CHARS = 20_000;
/** 引擎元素编号可能复用；历史正文去除这些编号，防止误用于当前页面。 */
const HISTORICAL_TARGET = /\s*\[target=[^\]]+\]|\bref=[^,\]\s]+/g;

/** 已执行命令的模型可见摘要，不包含调用权限。 */
export interface RecentOperation {
  /** 控制面保存的稳定命令身份。 */
  commandId: string;
  /** 封闭浏览器操作类型。 */
  operation: BrowserOperation['type'];
  /** 操作子类型，只在动作命令中存在。 */
  action?: string;
  /** 派发时的目标名称，不是可重放目标。 */
  targetName?: string;
  /** 执行器保留的输入摘要。 */
  value?: string;
  /** 命令执行状态。 */
  operationStatus: string;
  /** 是否已发生或可能发生副作用。 */
  effect: string;
}

/** 跨页面的阅读证据；不携带可用于当前动作的目标表。 */
export interface PreviousObservation {
  /** 原观察身份，仅用于来源追踪。 */
  observationId: string;
  /** 观察时的页面地址。 */
  url: string;
  /** 观察时的页面标题。 */
  title: string;
  /** 去除旧元素编号后的有界正文。 */
  text: string;
  /** 原观察的真实证据引用。 */
  artifactRefs: Observation['artifactRefs'];
  /** 正文是否因历史预算被截断。 */
  truncated: boolean;
}

/** 执行器传入事实快照；上下文模块不改变执行状态或原始证据。 */
export interface ContextInput {
  /** 当前步骤可见的任务定义。 */
  task: VerificationTask;
  /** 结构化任务中当前获准执行的步骤。 */
  executionStep: NonNullable<VerificationTask['steps']>[number] | undefined;
  /** 公共工作流的只读视图。 */
  workflow: WorkflowView | undefined;
  /** 剩余原任务动作、模型请求与时间预算。 */
  budgetRemaining: { actions: number; modelCalls: number; timeMs: number };
  /** 当前已核实可用的观察。 */
  current: Observation;
  /** 原始观察的跨轮变化，不包含推断的因果。 */
  changes: ObservationChanges | undefined;
  /** 当前执行已登记的完整证据集合。 */
  evidence: VerificationReport['artifacts'];
  /** 已执行操作的近期摘要。 */
  history: RecentOperation[];
  /** 有来源的历史页面正文。 */
  previousObservations: PreviousObservation[];
  /** 上轮执行错误或恢复提示。 */
  feedback: string | null;
  /** 与当前观察匹配、已核实的可选截图。 */
  image: string | undefined;
  /** 序列化文本的字符上限，不是供应商 token 上限。 */
  maxContextChars: number;
}

/** 历史归档先清除可复用的元素编号，再按原正文长度标记裁剪。 */
export function rememberObservation(
  history: PreviousObservation[],
  previous: Observation,
): void {
  history.push({
    observationId: previous.observationId,
    url: previous.url,
    title: previous.title,
    text: previous.text
      .replace(HISTORICAL_TARGET, '')
      .slice(0, OBSERVATION_HISTORY_CHARS),
    artifactRefs: previous.artifactRefs,
    truncated: previous.text.length > OBSERVATION_HISTORY_CHARS,
  });
  if (history.length > OBSERVATION_HISTORY_LIMIT) history.shift();
}

/** 标准保持完整；仅裁剪事实副本并声明缺口，无法容纳固定定义时明确失败。 */
export function decisionContext(input: ContextInput): DecisionInput {
  const current = input.current;
  const context = {
    task: input.task,
    executionStep: input.executionStep,
    workflow: input.workflow,
    budgetRemaining: {
      actions: input.budgetRemaining.actions,
      modelCalls: input.budgetRemaining.modelCalls,
      timeMs: input.budgetRemaining.timeMs,
    },
    changes: input.changes ? structuredClone(input.changes) : undefined,
    coverage: {
      capture: current.coverage ?? { status: 'unknown' },
      text: { truncated: current.truncated === true },
      controls: {
        observed: current.targets.length,
        returned: current.targets.length,
        omitted: 0,
      },
    },
    observation: {
      ...structuredClone(current),
      text: current.text,
      targets: [...current.targets],
    },
    evidence: input.evidence
      .slice(-EVIDENCE_LIMIT)
      .map(({ id, kind }) => ({ id, kind })),
    recentOperations: [...input.history],
    previousObservations: [...input.previousObservations],
    feedback:
      [
        input.feedback,
        (input.changes?.repeatedStateVisits ?? 0) >= 3
          ? '反复返回同一状态且没有阶段完成证据；请避免开关弹窗或来回导航，制定有界恢复计划。'
          : null,
        (input.changes?.unchangedRounds ?? 0) >= 2
          ? '连续操作后没有新增事实；请更换目标或策略，检查覆盖缺口，不要重复滚动或观察。'
          : null,
      ]
        .filter(Boolean)
        .join(' ') || null,
    truncated: false,
  };
  let text = JSON.stringify(context);
  while (text.length > input.maxContextChars) {
    context.truncated = true;
    if (context.previousObservations.length > 0)
      context.previousObservations.shift();
    else if (
      context.observation.network &&
      typeof context.observation.network === 'object' &&
      Array.isArray(
        (context.observation.network as { requests?: unknown[] }).requests,
      ) &&
      (context.observation.network as { requests: unknown[] }).requests.length >
        0
    ) {
      const network = context.observation.network as {
        requests: unknown[];
        truncated?: boolean;
      };
      const retained = Math.floor(network.requests.length / 2);
      network.requests = retained ? network.requests.slice(-retained) : [];
      network.truncated = true;
    } else if (context.observation.text.length > 256)
      context.observation.text = evidenceExcerpt(
        current.text,
        input.task.objective,
        Math.floor(context.observation.text.length / 2),
      );
    else if (context.changes && context.changes.text.length > 1024) {
      context.changes.text = context.changes.text.slice(
        0,
        Math.floor(context.changes.text.length / 2),
      );
      context.changes.textTruncated = true;
    } else if (context.observation.targets.length > 0)
      context.observation.targets = context.observation.targets.slice(
        0,
        Math.floor(context.observation.targets.length / 2),
      );
    else if (context.changes && context.changes.text.length > 128) {
      context.changes.text = context.changes.text.slice(
        0,
        Math.floor(context.changes.text.length / 2),
      );
      context.changes.textTruncated = true;
    } else if (
      context.changes &&
      (context.changes.added.length || context.changes.updated.length)
    ) {
      context.changes.added = [];
      context.changes.updated = [];
      context.changes.refsTruncated = true;
    } else if (context.recentOperations.length > 0)
      context.recentOperations.shift();
    else if (context.evidence.length > 0) context.evidence.shift();
    else
      throw new AgentFault(
        'CONTEXT_BUDGET_EXCEEDED',
        '固定任务定义超过模型上下文配置上限',
      );
    context.coverage.text.truncated =
      current.truncated === true || context.observation.text !== current.text;
    context.coverage.controls.returned = context.observation.targets.length;
    context.coverage.controls.omitted =
      current.targets.length - context.observation.targets.length;
    text = JSON.stringify(context);
  }
  return { text, ...(input.image ? { image: input.image } : {}) };
}
