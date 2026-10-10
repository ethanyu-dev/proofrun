import type { StepLimit, StepResult } from '@proofrun/contracts';
import type { ExecutionTiming } from '../client.js';
import { AgentFault } from '../http.js';

/** 独立额度只在安全点阻止新请求，不撤销租约或中断效果未知的浏览器命令。 */
export class StepAllowance {
  /** 服务端绝对期限转换到本地单调时钟，避免两种时钟直接相减。 */
  private deadline: number;
  /** 本地单调时钟的暂停点，空值表示继续消耗时间。 */
  private pausedAt: number | null = null;
  /** 清理多步共享起始计数；每步报告另用步骤起点记录增量。 */
  constructor(
    /** 只接受同一步骤的时间快照，清理切步保留累计额度。 */
    public stepId: string,
    /** 创建任务时冻结的限额。 */
    readonly limit: StepLimit,
    /** 阶段开始时全局动作基线。 */
    readonly actionsAtStart: number,
    /** 阶段开始时全局实际请求基线。 */
    readonly modelsAtStart: number,
    /** 清理阶段必须使用不暂停的墙钟期限。 */
    private readonly cleanup: boolean,
  ) {
    this.deadline = performance.now() + limit.timeoutMs;
  }

  /** 心跳只更新同一步；迟到的上一步快照不能侵占下一步额度。 */
  sync(view: ExecutionTiming) {
    if (view.stepBudget?.stepId !== this.stepId) return;
    const now = performance.now();
    const pausedAt = this.cleanup ? null : view.stepBudget.pausedAt;
    this.deadline =
      now + (view.stepBudget.deadlineAt - (pausedAt ?? Date.now()));
    this.pausedAt = pausedAt === null ? null : now;
  }

  /** 请求人工处理即暂停本地计时，随后用服务端快照校正。 */
  pause() {
    if (!this.cleanup) this.pausedAt ??= performance.now();
  }

  /** 仅供缺少时间快照的端口兼容；真实控制面会提供精确暂停期限。 */
  resume() {
    if (this.pausedAt !== null)
      this.deadline += performance.now() - this.pausedAt;
    this.pausedAt = null;
  }

  /** 剩余毫秒取整，避免向模型和报告暴露浮点时间误差。 */
  remaining() {
    return Math.max(
      0,
      Math.round(this.deadline - (this.pausedAt ?? performance.now())),
    );
  }

  /** 剩余额度是本步骤局部值，总计仍保留用于报告和成本统计。 */
  available(actions: number, models: number) {
    return {
      actions: Math.max(
        0,
        this.limit.maxActions - (actions - this.actionsAtStart),
      ),
      modelCalls: Math.max(
        0,
        this.limit.maxModelCalls - (models - this.modelsAtStart),
      ),
      timeMs: this.remaining(),
    };
  }

  /** 在安全点检查到期，不向租约控制器发送撤销信号。 */
  assertTime() {
    if (this.remaining() <= 0)
      throw new AgentFault(
        'STEP_TIME_BUDGET_EXCEEDED',
        `本步骤时间预算已耗尽（${this.limit.timeoutMs / 1000} 秒），后续步骤继续执行`,
      );
  }

  /** 请求前同时检查时间和对应次数，用稳定原因码保留未完成事实。 */
  assert(kind: 'actions' | 'modelCalls', actions: number, models: number) {
    this.assertTime();
    if (this.available(actions, models)[kind] <= 0) {
      const isAction = kind === 'actions';
      const max = isAction ? this.limit.maxActions : this.limit.maxModelCalls;
      throw new AgentFault(
        isAction ? 'STEP_ACTION_BUDGET_EXCEEDED' : 'STEP_MODEL_BUDGET_EXCEEDED',
        `本步骤${isAction ? '动作' : '模型请求'}预算已耗尽（${max}/${max}），后续步骤继续执行`,
      );
    }
  }

  /** 人工等待不计入业务耗时，命令收尾导致的少量超额如实保留。 */
  usage(
    actions: number,
    models: number,
  ): NonNullable<StepResult['budgetUsage']> {
    return {
      actions: Math.max(0, actions - this.actionsAtStart),
      modelCalls: Math.max(0, models - this.modelsAtStart),
      elapsedMs: Math.max(
        0,
        Math.round(
          this.limit.timeoutMs -
            this.deadline +
            (this.pausedAt ?? performance.now()),
        ),
      ),
      limit: {
        timeoutMs: this.limit.timeoutMs,
        maxActions: this.limit.maxActions,
        maxModelCalls: this.limit.maxModelCalls,
      },
    };
  }
}
