import { createHash } from 'node:crypto';
import type { Observation } from '../evidence/observation.js';
import { observationState } from '../evidence/changes.js';
import type { WorkflowView } from './workflow.js';
import { NavigationMemory } from './navigation-memory.js';

/** 策略版本写入每轮存档，配置在执行实例创建时固定。 */
export const GUIDANCE_VERSION = 'evidence-settlement-v2';
/** 最近观察状态的最大保留数量，用于检测短周期往返。 */
const WINDOW = 8;
/** 单次上下文携带的诊断事件上限，完整历史由调用归档保留。 */
const EVENT_LIMIT = 12;
/** 循环复核后允许两次新观察尝试不同路径，不通过改写计划刷新窗口。 */
const REVIEW_WINDOW = 2;

/** 由执行事实生成的决策诊断，不具有验收通过权限。 */
export interface GuidanceInput {
  /** 当前完整观察，来源已经由执行器验证。 */
  page: Observation;
  /** 当前工作流的只读快照。 */
  workflow: WorkflowView;
  /** 原标准尚未取得明确结论的身份，不复制验收账本。 */
  pending: string[];
  /** 只有首次记录的步骤、阅读与验收结论可以推进。 */
  progressKey: string;
  /** 步骤、准备阶段及控制代次共同界定有效范围。 */
  scope: string;
  /** 实际剩余额度，估算不得修改它。 */
  budget: { actions: number; modelCalls: number; timeMs: number };
}

/** 公共执行层的有界检测器，LLM 与 JEV 使用同一事实和事件。 */
export class ExecutionGuidance {
  /** 当前执行范围；变更时重新建立定位记忆。 */
  private scope = '';
  /** 防止同一观察的模型重试重复计数。 */
  private observationId = '';
  /** 权威账本的进度身份，与模型计划身份分离。 */
  private progressKey = '';
  /** 有界页面访问序列，只用于循环判断。 */
  private states: string[] = [];
  /** 实际新观察的递增序号。 */
  private sequence = 0;
  /** 对同一组线索去重，防止定位阶段每个动作都额外请求 LLM。 */
  private locatedHints = new Set<string>();
  /** 最近复核序号，仅控制提示频率，不清空循环事实。 */
  private lastReview = -REVIEW_WINDOW;
  /** 有界诊断事件，完整历史随每次模型请求归档。 */
  private events: Array<{
    sequence: number;
    code: string;
    observationId: string;
  }> = [];
  /** 当前执行实例的语义位置线索。 */
  private navigation = new NavigationMemory();

  /** 控制权或执行范围变化使定位线索失效；全局预算仍由执行器保留。 */
  reset(scope: string) {
    this.scope = scope;
    this.observationId = '';
    this.progressKey = '';
    this.states = [];
    this.navigation = new NavigationMemory();
    this.locatedHints.clear();
    this.lastReview = -REVIEW_WINDOW;
  }

  /** 导航会使旧位置失效，但不能清空循环历史。 */
  invalidateNavigation() {
    this.navigation = new NavigationMemory();
  }

  /** 每份观察只计一次；模型重试或登记计划不会伪造页面访问次数。 */
  view(input: GuidanceInput) {
    if (this.scope !== input.scope) this.reset(input.scope);
    const hadProgress = this.progressKey !== '';
    const progressed = this.progressKey !== input.progressKey;
    if (progressed) {
      this.states = [];
      this.progressKey = input.progressKey;
    }
    const fresh = this.observationId !== input.page.observationId;
    if (fresh) {
      this.observationId = input.page.observationId;
      this.sequence++;
      this.navigation.observe(input.page);
      // 不使用截图哈希、临时目标编号或像素布局，避免动画干扰；控件状态和正文仍保留。
      const key = createHash('sha256')
        .update(observationState(input.page))
        .digest('hex');
      this.states.push(key);
      if (this.states.length > WINDOW) this.states.shift();
    }
    const plan = input.workflow.recovery;
    const hints = this.navigation.hints(input.page, plan?.terms ?? []);
    const travel =
      hints.find((hint) => hint.estimatedScrolls !== null)?.estimatedScrolls ??
      null;
    const estimatedActions =
      travel === null ? null : travel + (plan?.phase === 'locate' ? 1 : 2);
    const key = this.states.at(-1);
    const visits = this.states.filter((state) => state === key).length;
    const cycle = visits >= 2 && this.states.length >= 3;
    const exhausted = plan?.remaining === 0;
    let review: string | null = !plan
      ? 'PLAN_REQUIRED'
      : exhausted
        ? 'PLAN_EXHAUSTED'
        : null;
    if (!review && progressed && hadProgress) review = 'TASK_PROGRESS';
    const visibleHintKey = JSON.stringify(
      hints
        .filter((hint) => !hint.historical)
        .map((hint) => [hint.frame, hint.role, hint.name])
        .sort(),
    );
    if (
      !review &&
      plan?.phase === 'locate' &&
      visibleHintKey !== '[]' &&
      !this.locatedHints.has(visibleHintKey)
    ) {
      this.locatedHints.add(visibleHintKey);
      if (this.locatedHints.size > WINDOW)
        this.locatedHints.delete(this.locatedHints.values().next().value!);
      review = 'TARGET_LOCATED';
    }
    if (!review && this.sequence - this.lastReview >= REVIEW_WINDOW) {
      if (cycle) review = 'STATE_CYCLE';
      else if (
        estimatedActions !== null &&
        estimatedActions >= input.budget.actions
      )
        review = 'WORK_BUDGET_LOW';
      else if (
        input.budget.actions <= 3 ||
        input.budget.modelCalls <= 2 ||
        input.budget.timeMs <= 15_000
      )
        review = 'BUDGET_LOW';
    }
    if (review && (fresh || this.events.at(-1)?.code !== review)) {
      this.lastReview = this.sequence;
      this.events.push({
        sequence: this.sequence,
        code: review,
        observationId: this.observationId,
      });
      if (this.events.length > EVENT_LIMIT) this.events.shift();
    }
    return {
      version: GUIDANCE_VERSION,
      scope: this.scope,
      review,
      pendingCriterionIds: input.pending,
      currentPlan: plan
        ? {
            id: plan.id,
            phase: plan.phase ?? 'interact',
            goal: plan.goal,
            successCondition: plan.successCondition,
            remaining: plan.remaining,
          }
        : null,
      progress: {
        taskAdvanced: progressed,
        retainedStates: this.states.length,
        currentStateVisits: visits,
      },
      navigation: hints,
      budget: { ...input.budget, estimatedActions, estimateUncertain: true },
      events: [...this.events],
    };
  }
}
/** 序列化视图供上下文与控制台读取，完整状态只在执行器内保存。 */
export type GuidanceView = ReturnType<ExecutionGuidance['view']>;
