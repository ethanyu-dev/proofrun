import type { AgentDecision } from '@proofrun/contracts';
import { AgentFault } from '../http.js';

/** 只拆分行首的显式编号步骤；自由文本保留整体要求，避免猜测或重写验收语义。 */
const STEP_LINE = /^\s*(?:\d{1,2}[.、)]|[（(]\d{1,2}[)）])\s+(.+)$/u;
/** 原始编号要求的数量上限；超过时保留完整原文，不截掉尾部要求。 */
const MAX_STEPS = 32;
/** setup 描述与最多 32 条 policy 各自需要一份完成声明。 */
const MAX_ASSESSMENTS = MAX_STEPS + 1;
const MAX_NOTE = 600;
/** 每项声明引用的证据数量上限。 */
const MAX_EVIDENCE_REFS = 24;

/** 模型提交的是带证据的完成声明；执行器验证来源，不冒充业务语义判定器。 */
export interface WorkflowUpdate {
  /** 原任务要求重查或验证开关行为时解释原因，不清空读取证据或恢复额度。 */
  revisitReason?: string;
  /** 逐项阅读只能引用执行器已观察的关联面板，不增加原验收要求。 */
  readings?: Array<{ itemId: string; quote: string }>;
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
}
/** 原始要求的只读进度视图；只有原始要求可以成为必做步骤。 */
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
  /** 只有步骤首次提交完成证据才增长，用于区分任务进展与页面循环。 */
  revision: number;
}

/** 仅模型工具额外携带该元数据，不扩展浏览器命令协议或节点权限。 */
export const WORKFLOW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    revisitReason: { type: 'string', minLength: 1, maxLength: MAX_NOTE },
    readings: {
      type: 'array',
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          itemId: { type: 'string' },
          quote: { type: 'string', minLength: 1, maxLength: 600 },
        },
        required: ['itemId', 'quote'],
      },
    },
    assessments: {
      type: 'array',
      maxItems: MAX_ASSESSMENTS,
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
  },
};

/** 校验全部元数据后再原子更新；非法证据或未知步骤不得留下半完成状态。 */
export class Workflow {
  /** 单执行状态；通过副本返回，调用方不能绕过校验修改。 */
  private state: WorkflowView;
  /** 同一步重新评估不反复清空全局循环计数。 */
  private credited = new Set<string>();
  constructor(
    objective: string,
    structuredStepId?: string,
    /** setup 逐条保留描述与约束，禁止用关键词猜测或遗漏身份要求。 */
    private readonly preparation?: string[],
  ) {
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
      preparation ??
      (!structuredStepId && numbered.length > 1 && numbered.length <= MAX_STEPS
        ? numbered
        : [objective]);
    this.state = {
      steps: requirements.map((requirement, i) => ({
        // 结构化执行已经由上层拆步，不能再次编号或解析说明中的编号列表。
        id: structuredStepId
          ? i === 0
            ? structuredStepId
            : `${structuredStepId}-policy-${i}`
          : `step-${i + 1}`,
        requirement,
        status: 'pending',
        evidenceRefs: [],
      })),
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
        'workflow 更新无效：只能引用原步骤和已登记证据，不接受局部计划或焦点切换',
      );
    const object = (v: unknown): v is Record<string, unknown> =>
      !!v && typeof v === 'object' && !Array.isArray(v);
    const note = (v: unknown) =>
      typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_NOTE;
    if (!object(update))
      throw new AgentFault(
        'INVALID_MODEL_DECISION',
        'workflow 必须是对象，完成声明放在 workflow.assessments 数组中',
      );
    if (
      Object.keys(update).some(
        (k) => !['assessments', 'readings', 'revisitReason'].includes(k),
      )
    )
      throw bad();
    if (update.revisitReason !== undefined && !note(update.revisitReason))
      throw bad();
    const next = this.view();
    const credited = new Set(this.credited);
    if (update.assessments !== undefined) {
      if (
        !Array.isArray(update.assessments) ||
        update.assessments.length > MAX_ASSESSMENTS
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
          item.evidenceRefs.some((r) => typeof r !== 'string')
        )
          throw bad();
        const unknownRefs = item.evidenceRefs.filter(
          (ref) => !evidence.has(ref),
        );
        if (unknownRefs.length)
          throw new AgentFault(
            'INVALID_MODEL_DECISION',
            `progress.requirements[${step.id}].evidenceRefs 引用了未登记附件：${JSON.stringify(unknownRefs)}。observationId 不是附件 ID；请从 evidence 或 artifactRefs 逐字复制实际支持本项的附件，不能猜测或改写 UUID。`,
          );
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
      }
    }
    this.state = next;
    this.credited = credited;
  }
  /** 人工可能切换账号或环境；原完成声明失效，历史进展额度不重复发放。 */
  invalidateAssessments() {
    for (const step of this.state.steps) {
      step.status = 'pending';
      step.evidenceRefs = [];
      delete step.summary;
    }
  }
  /** setup 必须逐条留证；任何单步显式未完成都不能被 finish 覆盖。 */
  assertFinish(decision: AgentDecision) {
    if (
      decision.type === 'verification.finish' &&
      this.state.steps.some((s) =>
        this.preparation || this.state.steps.length > 1
          ? s.status !== 'recorded'
          : s.status === 'incomplete' || s.status === 'blocked',
      )
    )
      throw new AgentFault(
        'WORKFLOW_INCOMPLETE',
        `原始任务仍有未完成步骤：${this.state.steps
          .filter((s) => s.status !== 'recorded')
          .map((s) => `${s.id}(${s.status})：${s.summary ?? s.requirement}`)
          .join(
            '、',
          )}；请继续执行、重新进入已访问步骤补证据，或 verification_block，不能只按部分 criterionId 提前结束`,
      );
  }
}
