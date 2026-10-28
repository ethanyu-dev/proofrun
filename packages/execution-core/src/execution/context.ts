import type { NetworkReadReceipt } from '../evidence/network-reads.js';
import { evidenceExcerpt } from '../model/evidence-excerpt.js';
import {
  networkView,
  trimNetworkView,
  type NetworkSelection,
} from '../evidence/network-view.js';
import type { VerificationReport, VerificationTask } from '@proofrun/contracts';
import type { BrowserOperation } from '../ports.js';
import type { Observation } from '../evidence/observation.js';
import type { ObservationChanges } from '../evidence/changes.js';
import type { DecisionInput } from '../model.js';
import type { WorkflowView } from './workflow.js';
import type { CheckResult } from './identity.js';
import type { PolicyResult } from './policy-checks.js';
import type { InteractionProgress } from './interaction-progress.js';
import type { OperationJournal } from './operation-journal.js';
import { AgentFault } from '../faults.js';

/** 只保留有界历史正文；历史元素编号永远不作为当前操作身份。 */
const HISTORY_LIMIT = 8;
const HISTORY_CHARS = 20_000;
/** 先为正文保留可读空间，再裁剪可分页列表；极小总预算仍允许继续缩减。 */
const BODY_RESERVE_CHARS = 4_000;
/** 正文低于此值时不再牺牲证据语义，固定内容仍超限则明确拒绝。 */
const MIN_BODY_CHARS = 256;
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
  /** 定向按键的请求目标，仅表示意图，不能作为实际焦点证据。 */
  requestedTargetName?: string;
  /** focusVerified 仅确认派发按键前的焦点，不证明失焦事件或业务校验结果。 */
  keyboard?: {
    scope: 'target' | 'current-focus' | 'unknown';
    focusVerified: boolean;
  };
  /** 执行器保留的输入摘要。 */
  value?: string;
  /** Cookie 清理只向模型返回名字和验证结果，不含值。 */
  cookieCleanup?: { names: string[]; verified: boolean };
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
  /** 观察时各文档的语言声明；与该次正文一起保存，不能推断当前语言。 */
  documents?: Observation['documents'];
  /** 去除旧元素编号后的有界正文。 */
  text: string;
  /** 原观察的真实证据引用。 */
  artifactRefs: Observation['artifactRefs'];
  /** 正文是否因历史预算被截断。 */
  truncated: boolean;
}

/** 输入来自权威账本，投影和裁剪只修改副本。 */
export interface ContextInput {
  task: VerificationTask;
  /** 原始任务背景，不拼接当前步骤或阶段提示。 */
  background?: string;
  executionStep: NonNullable<VerificationTask['steps']>[number] | undefined;
  setupPhase?: 'PREPARING' | 'CHECKING' | undefined;
  cleanup?: boolean;
  verificationReview?: { final?: boolean; reason?: 'budget' } | undefined;
  recordedCriteria?: VerificationReport['criteria'];
  preconditions: CheckResult[];
  sessionPreconditions?: CheckResult[];
  policyChecks?: PolicyResult[];
  workflow: WorkflowView | undefined;
  interactionProgress?: ReturnType<InteractionProgress['view']>;
  budgetRemaining: { actions: number; modelCalls: number; timeMs: number };
  current: Observation;
  /** 本轮主动读取的网络列表或详情；新观察自动使旧选择失效。 */
  networkSelection?: NetworkSelection;
  /** 同一模型回复中其它纯读取的结果，仅保留最近批次。 */
  networkBatchSelections?: NetworkSelection[];
  /** 当前网络快照中的有界读取回执，保留零匹配和已读身份。 */
  networkReads?: NetworkReadReceipt[];
  changes: ObservationChanges | undefined;
  evidence: VerificationReport['artifacts'];
  history: RecentOperation[];
  actionMemory?: ReturnType<OperationJournal['critical']>;
  previousObservations: PreviousObservation[];
  feedback: string | null;
  image: string | undefined;
  maxContextChars: number;
}

/** 归档剔除历史元素编号，不能借旧页面内容重放操作。 */
export function rememberObservation(
  history: PreviousObservation[],
  previous: Observation,
): void {
  history.push({
    observationId: previous.observationId,
    url: previous.url,
    title: previous.title,
    documents: structuredClone(previous.documents),
    text: previous.text.replace(HISTORICAL_TARGET, '').slice(0, HISTORY_CHARS),
    artifactRefs: previous.artifactRefs,
    truncated:
      previous.truncated === true || previous.text.length > HISTORY_CHARS,
  });
  if (history.length > HISTORY_LIMIT) history.shift();
}

/** 白名单投影是唯一模型视图；没有身份配方、调度元数据或第二份局部计划。 */
function contextData(input: ContextInput) {
  const { current, executionStep: step } = input;
  const allowed = new Set(input.evidence.map((item) => item.id));
  const refs = (values: string[]) => values.filter((id) => allowed.has(id));
  const excerpts = new Map<string, PreviousObservation>();
  for (const item of input.previousObservations) {
    const key = JSON.stringify([
      item.url,
      item.title,
      item.documents,
      item.text,
      item.truncated,
    ]);
    const old = excerpts.get(key);
    excerpts.set(key, {
      ...structuredClone(item),
      artifactRefs: [
        ...new Map(
          [...(old?.artifactRefs ?? []), ...item.artifactRefs]
            .filter((ref) => allowed.has(ref.artifactId))
            .map((ref) => [ref.artifactId, ref]),
        ).values(),
      ],
    });
  }
  const requirements = input.workflow?.steps ?? [];
  return {
    task: {
      kind: input.task.taskKind ?? 'verification',
      background: input.background,
      stepId: step?.stepId,
      description: step?.description ?? input.task.objective,
      url: step?.url ?? input.task.target.url,
      policy: step?.policy,
      criteria: structuredClone(input.task.acceptanceCriteria),
      permissions: {
        allowIntervention: input.task.environment.allowIntervention,
      },
      // 原文出现一次，账本只引用稳定要求身份；结构化步骤不重复拆解描述。
      requirements: requirements.map((item) => ({
        id: item.id,
        requirement: item.requirement,
      })),
    },
    state: {
      phase: input.cleanup
        ? 'CLEANUP'
        : (input.setupPhase ??
          (step?.type === 'setup' ? 'PREPARING' : 'VERIFYING')),
      settlement: input.verificationReview?.final
        ? (input.verificationReview.reason ?? 'stalled')
        : null,
      criteria: structuredClone(input.recordedCriteria ?? []),
      networkReads: structuredClone(input.networkReads ?? []),
      conditions: [
        ...input.preconditions.map((item) => ({
          ...structuredClone(item),
          scope: 'current',
        })),
        ...(input.sessionPreconditions ?? []).map((item) => ({
          ...structuredClone(item),
          scope: 'preparation',
        })),
        ...(input.policyChecks ?? []).map((item) => ({
          ...structuredClone(item),
          scope: 'policy',
        })),
      ],
      requirements: requirements.map(({ requirement: _text, ...item }) => ({
        ...structuredClone(item),
        evidenceRefs: refs(item.evidenceRefs),
      })),
      readings: input.interactionProgress
        ? structuredClone(input.interactionProgress)
        : undefined,
    },
    page: {
      observationId: current.observationId,
      url: current.url,
      title: current.title,
      text: current.text,
      documents: structuredClone(current.documents),
      targets: current.targets.map(({ comparisonKey: _key, ...target }) =>
        structuredClone(target),
      ),
      tabs: structuredClone(current.tabs),
      viewport: structuredClone(current.viewport),
      atomic: current.atomic,
      network: networkView(
        {
          ...current,
          artifactRefs: current.artifactRefs.filter((ref) =>
            allowed.has(ref.artifactId),
          ),
        },
        input.networkSelection,
        input.networkBatchSelections,
      ),
      runtime: structuredClone(current.runtime),
      artifactRefs: current.artifactRefs.filter((ref) =>
        allowed.has(ref.artifactId),
      ),
      coverage: {
        capture: structuredClone(current.coverage ?? { status: 'unknown' }),
        text: { truncated: current.truncated === true },
        controls: {
          observed: current.targets.length,
          returned: current.targets.length,
          omitted: 0,
        },
      },
    },
    history: {
      commands: [
        ...new Map(
          [
            ...(input.actionMemory?.items ?? []).filter(
              (item) =>
                !input.history.some(
                  (recent) => recent.commandId === item.commandId,
                ),
            ),
            ...input.history,
          ].map((item) => [item.commandId, structuredClone(item)]),
        ).values(),
      ],
      omittedCommands: input.actionMemory?.omitted ?? 0,
      excerpts: [...excerpts.values()],
      omittedExcerpts: 0,
    },
    evidence: input.evidence.map(({ id, kind }) => ({ id, kind })),
    budget: { ...input.budgetRemaining },
    feedback: [
      ...(input.feedback
        ? [{ code: 'EXECUTION_FEEDBACK', message: input.feedback }]
        : []),
      ...((input.changes?.unchangedRounds ?? 0) >= 2
        ? [
            {
              code: 'OBSERVATION_STALLED',
              count: input.changes!.unchangedRounds,
            },
          ]
        : []),
      ...((input.changes?.repeatedStateVisits ?? 0) >= 3
        ? [
            {
              code: 'REPEATED_STATE',
              count: input.changes!.repeatedStateVisits,
            },
          ]
        : []),
    ],
  };
}

/** 最终请求数据由唯一构造器推导，工具和模型不得另建视图。 */
export type DecisionContextData = ReturnType<typeof contextData>;

/** 运行时列表只裁剪模型副本并标注不完整，完整内容仍通过 RUNTIME/NETWORK 附件归档。 */
function trimRuntimeLists(...values: unknown[]): boolean {
  let candidate:
    { parent: Record<string, unknown>; key: string; bytes: number } | undefined;
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const parent = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(parent)) {
      if (Array.isArray(item) && item.length) {
        const bytes = JSON.stringify(item).length;
        if (!candidate || bytes > candidate.bytes)
          candidate = { parent, key, bytes };
      } else visit(item);
    }
  };
  values.forEach(visit);
  if (!candidate) return false;
  const { parent, key } = candidate;
  const entries = parent[key] as unknown[];
  parent[key] = entries.slice(0, Math.floor(entries.length / 2));
  parent.truncated = true;
  parent.complete = false;
  return true;
}

/** 优先裁剪重复历史和页面正文；固定约束与关键回执装不下时明确失败。 */
export function boundContext(
  context: DecisionContextData,
  maxContextChars: number,
) {
  // 只读原文保存在执行器，不发两份正文；每次缩减都重新从同一原文取片段。
  const originalText = context.page.text;
  const objective = [
    context.task.description,
    ...context.task.criteria.map((item) => item.expectedResult),
  ].join(' ');
  let bodyBudget = originalText.length;
  const shrinkBody = (floor: number) => {
    bodyBudget = Math.max(floor, Math.floor(bodyBudget / 2));
    context.page.text = evidenceExcerpt(originalText, objective, bodyBudget);
    context.page.coverage.text.truncated = true;
  };
  let text = JSON.stringify(context);
  while (text.length > maxContextChars) {
    if (context.history.excerpts.length) {
      context.history.excerpts.shift();
      context.history.omittedExcerpts++;
    } else if (bodyBudget > BODY_RESERVE_CHARS) {
      shrinkBody(BODY_RESERVE_CHARS);
    } else if (trimRuntimeLists(context.page.runtime)) {
      // 保留摘要和附件引用；禁止把裁剪后的列表当作全量检查。
    } else if (trimNetworkView(context.page.network)) {
      // 网络请求详情不会被机械截断，列表的剩余记录仍可分页读取。
    } else if (bodyBudget > MIN_BODY_CHARS) {
      shrinkBody(MIN_BODY_CHARS);
    } else if (
      context.state.readings?.items.some((item) => item.text.length > 80)
    ) {
      context.state.readings.items = context.state.readings.items.map(
        (item) => ({
          ...item,
          text: item.text.slice(0, 80),
          truncated: item.truncated || item.text.length > 80,
        }),
      );
    } else if ((context.state.readings?.items.length ?? 0) > 1) {
      const readings = context.state.readings!;
      const pending = readings.items.findLastIndex(
        (item) => item.status !== 'recorded',
      );
      const index = pending < 0 ? readings.items.length - 1 : pending;
      readings.items.splice(index, 1);
      readings.omittedItems++;
    } else if (context.page.targets.length) {
      context.page.targets = context.page.targets.slice(
        0,
        Math.floor(context.page.targets.length / 2),
      );
      context.page.coverage.controls.returned = context.page.targets.length;
      context.page.coverage.controls.omitted =
        context.page.coverage.controls.observed - context.page.targets.length;
    } else
      throw new AgentFault(
        'CONTEXT_BUDGET_EXCEEDED',
        '固定要求、进度或关键回执超过模型上下文上限',
      );
    text = JSON.stringify(context);
  }
  return { text, context };
}

/** 返回同一裁剪快照；图片必须与当前观察匹配，完整观察留在执行器。 */
export function decisionContext(input: ContextInput): DecisionInput {
  return {
    ...boundContext(contextData(input), input.maxContextChars),
    ...(input.image ? { image: input.image } : {}),
  };
}
