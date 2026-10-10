import type { AgentDecision } from '@proofrun/contracts';
import { AgentFault } from '../http.js';

/** 只拆分行首的显式编号步骤；自由文本保留整体要求，避免猜测或重写验收语义。 */
const STEP_LINE = /^\s*(?:\d{1,2}[.、)]|[（(]\d{1,2}[)）])\s+(.+)$/u;
/** 控制计划元数据长度，不能挤掉原始任务或变成无限恢复预算。 */
const MAX_STEPS = 32;
const MAX_NOTE = 600;
const MAX_RECOVERY_ACTIONS = 6;
/** 每步证据和检索词分别限额，完整原始任务仍由执行器保留。 */
const MAX_EVIDENCE_REFS = 24;
const MAX_TERMS = 8;
const TERM_CHARS = 80;

/** 模型提交的是带证据的完成声明；执行器验证来源，不冒充业务语义判定器。 */
export interface WorkflowUpdate {
  /** 已观察事实的逐步骤声明，不能认领待执行动作。 */
  assessments?: Array<{
    /** 必须匹配原任务步骤身份。 */
    stepId: string;
    /** 明确区分完成、证据不全和受阻，不能把尝试当作完成。 */
    outcome: 'complete' | 'incomplete' | 'blocked';
    /** 控制面已登记的当前执行证据。 */
    evidenceRefs: string[];
    /** 解释所引用证据支持的已观察事实。 */
    summary: string;
  }>;
  /** 可以调整访问顺序，但其余未完成要求始终保留。 */
  activeStep?: string;
  /** 当前阶段的临时恢复策略，不取代原任务要求。 */
  recovery?: {
    /** 这次恢复试图达到的局部状态。 */
    goal: string;
    /** 已观察的区域描述，仅用于排序，未知时为空。 */
    scope: string;
    /** 有界检索词，不是选择器或可执行脚本。 */
    terms: string[];
    /** 下一轮需要观察的成功条件，不能凭文字自动判通过。 */
    successCondition: string;
    /** 成功派发的浏览器动作预算。 */
    maxActions: number;
  };
}
/** 两种决策模式共享的任务进度视图；只有原始要求可以成为必做步骤。 */
export interface WorkflowView {
  /** 来自原始任务的要求和可审计完成证据。 */
  steps: Array<{
    /** 执行内稳定步骤身份。 */
    id: string;
    /** 保留原始步骤文字及延续行。 */
    requirement: string;
    /** recorded 仅表示模型提供有效来源的声明，非程序证明业务通过。 */
    status: 'pending' | 'recorded' | 'incomplete' | 'blocked';
    /** 控制面已登记的当前执行证据。 */
    evidenceRefs: string[];
    /** 模型对已观察事实的有界说明。 */
    summary?: string;
  }>;
  /** 当前焦点；全部要求记录后为空。 */
  activeStep: string | null;
  /** 跨轮策略及剩余动作预算，不保存旧 target。 */
  recovery:
    (NonNullable<WorkflowUpdate['recovery']> & { remaining: number }) | null;
  /** 只有步骤首次提交完成证据才增长，用于区分任务进展与页面循环。 */
  revision: number;
}

/** 仅模型工具额外携带该元数据，不扩展浏览器命令协议或节点权限。 */
export const WORKFLOW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    assessments: {
      type: 'array',
      maxItems: MAX_STEPS,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stepId: { type: 'string' },
          outcome: {
            type: 'string',
            enum: ['complete', 'incomplete', 'blocked'],
          },
          summary: { type: 'string', maxLength: MAX_NOTE },
          evidenceRefs: {
            type: 'array',
            minItems: 0,
            maxItems: MAX_EVIDENCE_REFS,
            items: { type: 'string' },
          },
        },
        required: ['stepId', 'outcome', 'summary', 'evidenceRefs'],
      },
    },
    activeStep: { type: 'string' },
    recovery: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { type: 'string', maxLength: MAX_NOTE },
        scope: { type: 'string', maxLength: MAX_NOTE },
        terms: {
          type: 'array',
          maxItems: MAX_TERMS,
          items: { type: 'string', maxLength: TERM_CHARS },
        },
        successCondition: { type: 'string', maxLength: MAX_NOTE },
        maxActions: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_RECOVERY_ACTIONS,
        },
      },
      required: ['goal', 'scope', 'terms', 'successCondition', 'maxActions'],
    },
  },
};

/** 校验全部元数据后再原子更新；非法证据或未知步骤不得留下半完成状态。 */
export class Workflow {
  /** 单执行状态；通过副本返回，调用方不能绕过校验修改。 */
  private state: WorkflowView;
  /** 同一步重新评估不反复清空全局循环计数。 */
  private credited = new Set<string>();
  constructor(objective: string, structuredStepId?: string) {
    const lines = objective.split('\n');
    const starts = lines.flatMap((line, index) =>
      STEP_LINE.test(line) ? [index] : [],
    );
    // 延续行随所属步骤保留；前置条件仍以完整 task.objective 为准，不编造阶段。
    const numbered = starts.map((start, i) =>
      [
        STEP_LINE.exec(lines[start]!)![1]!,
        ...lines.slice(start + 1, starts[i + 1] ?? lines.length),
      ]
        .join('\n')
        .trim(),
    );
    // 过长或非编号任务仍完整保留，由模型按原文执行，不机械截掉尾部要求。
    const requirements =
      !structuredStepId && numbered.length > 1 && numbered.length <= MAX_STEPS
        ? numbered
        : [objective];
    this.state = {
      steps: requirements.map((requirement, i) => ({
        // 结构化执行已经由上层拆步，不能再次编号或解析说明中的编号列表。
        id: structuredStepId ?? `step-${i + 1}`,
        requirement,
        status: 'pending',
        evidenceRefs: [],
      })),
      activeStep: structuredStepId ?? 'step-1',
      recovery: null,
      revision: 0,
    };
  }
  /** 返回快照供模型与审计使用。 */
  view(): WorkflowView {
    return structuredClone(this.state);
  }
  /** 元数据仅描述本次决定之前已观察到的事实，禁止预先认领即将执行的动作。 */
  apply(update: unknown, evidence: Set<string>) {
    if (update === undefined) return;
    const bad = () =>
      new AgentFault(
        'INVALID_MODEL_DECISION',
        'workflow 更新无效：只能引用原步骤和已登记证据，恢复计划必须有界',
      );
    const object = (v: unknown): v is Record<string, unknown> =>
      !!v && typeof v === 'object' && !Array.isArray(v);
    const note = (v: unknown) =>
      typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_NOTE;
    if (
      !object(update) ||
      Object.keys(update).some(
        (k) => !['assessments', 'activeStep', 'recovery'].includes(k),
      )
    )
      throw bad();
    const next = this.view();
    const credited = new Set(this.credited);
    if (update.assessments !== undefined) {
      if (
        !Array.isArray(update.assessments) ||
        update.assessments.length > MAX_STEPS
      )
        throw bad();
      const seen = new Set<string>();
      for (const item of update.assessments) {
        if (
          !object(item) ||
          Object.keys(item).some(
            (k) =>
              !['stepId', 'outcome', 'summary', 'evidenceRefs'].includes(k),
          )
        )
          throw bad();
        const step = next.steps.find((s) => s.id === item.stepId);
        if (
          !step ||
          seen.has(step.id) ||
          !note(item.summary) ||
          !Array.isArray(item.evidenceRefs) ||
          !['complete', 'incomplete', 'blocked'].includes(
            String(item.outcome),
          ) ||
          (item.outcome === 'complete' && !item.evidenceRefs.length) ||
          item.evidenceRefs.length > MAX_EVIDENCE_REFS ||
          item.evidenceRefs.some(
            (r) => typeof r !== 'string' || !evidence.has(r),
          )
        )
          throw bad();
        seen.add(step.id);

        Object.assign(step, {
          status: item.outcome === 'complete' ? 'recorded' : item.outcome,
          summary: item.summary,
          evidenceRefs: [...new Set(item.evidenceRefs)],
        });
        if (item.outcome === 'complete' && !credited.has(step.id)) {
          credited.add(step.id);
          next.revision++;
        }
        if (step.id === next.activeStep && item.outcome === 'complete')
          next.recovery = null;
      }
    }
    if (update.activeStep !== undefined) {
      if (!next.steps.some((s) => s.id === update.activeStep)) throw bad();
      if (next.activeStep !== update.activeStep) next.recovery = null;
      next.activeStep = update.activeStep as string;
    } else if (
      next.activeStep === null ||
      (Array.isArray(update.assessments) &&
        update.assessments.some(
          (item) =>
            item.stepId === next.activeStep && item.outcome === 'complete',
        ))
    ) {
      next.activeStep =
        next.steps.find((s) => s.status !== 'recorded')?.id ?? null;
    }
    if (update.recovery !== undefined) {
      const r = update.recovery;
      if (
        !next.activeStep ||
        !object(r) ||
        Object.keys(r).some(
          (k) =>
            ![
              'goal',
              'scope',
              'terms',
              'successCondition',
              'maxActions',
            ].includes(k),
        ) ||
        !note(r.goal) ||
        typeof r.scope !== 'string' ||
        r.scope.length > MAX_NOTE ||
        !note(r.successCondition) ||
        !Array.isArray(r.terms) ||
        r.terms.length > MAX_TERMS ||
        r.terms.some(
          (t) => typeof t !== 'string' || !t.trim() || t.length > TERM_CHARS,
        ) ||
        !Number.isInteger(r.maxActions) ||
        Number(r.maxActions) < 1 ||
        Number(r.maxActions) > MAX_RECOVERY_ACTIONS
      )
        throw bad();
      // 同一计划重送不能重置预算，防止每轮重新规划绕过上限。
      const old = next.recovery;
      const same =
        old &&
        old.goal === r.goal &&
        old.scope === r.scope &&
        old.successCondition === r.successCondition &&
        JSON.stringify(old.terms) === JSON.stringify(r.terms);
      next.recovery = {
        ...(r as unknown as NonNullable<WorkflowUpdate['recovery']>),
        remaining: same
          ? Math.min(old.remaining, Number(r.maxActions))
          : Number(r.maxActions),
      };
    }
    this.state = next;
    this.credited = credited;
  }
  /** 真正成功执行浏览器动作后扣减；重新观察或重规划不计作恢复成功。 */
  acted() {
    if (this.state.recovery)
      this.state.recovery.remaining = Math.max(
        0,
        this.state.recovery.remaining - 1,
      );
  }
  /** 预算耗尽后必须完成取证或更换计划，不能忽略旧计划继续操作。 */
  assertAction(decision: AgentDecision) {
    if (decision.type === 'browser.act' && this.state.recovery?.remaining === 0)
      throw new AgentFault(
        'WORKFLOW_RECOVERY_EXHAUSTED',
        '恢复计划已耗尽，请核对证据并完成阶段、改变恢复策略或停止；重送同一计划不会重置预算',
      );
  }
  /** 人工接管改变了页面状态，丢弃恢复策略但保留历史证据记录。 */
  invalidateRecovery() {
    this.state.recovery = null;
  }
  /** 单一自由文本任务沿用最终报告；明确多步骤任务必须分别留下执行证据。 */
  assertFinish(decision: AgentDecision) {
    if (
      decision.type === 'verification.finish' &&
      this.state.steps.length > 1 &&
      this.state.steps.some((s) => s.status !== 'recorded')
    )
      throw new AgentFault(
        'WORKFLOW_INCOMPLETE',
        `原始任务仍有未完成步骤：${this.state.steps
          .filter((s) => s.status !== 'recorded')
          .map((s) => s.id + '(' + s.status + ')')
          .join(
            '、',
          )}；请继续执行、重新进入已访问步骤补证据，或 verification_block，不能只按部分 criterionId 提前结束`,
      );
  }
}
