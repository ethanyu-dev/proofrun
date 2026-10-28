import type { DecisionInput } from '@proofrun/execution-core/model';

/** 一次等待的单调时钟边界；读取和 touch 都不能重新计时。 */
export class DecisionWindow {
  /** 步骤原有硬期限，不因网络读取或上下文读取延长。 */
  readonly stepDeadline: number;
  /** 探索决定必须给共享驱动留下既有收尾额度。 */
  readonly decisionDeadline: number;
  /** 用于客户端展示的 UTC 边界，授权判断仍使用单调时钟。 */
  private readonly wallOffset: number;

  constructor(
    input: DecisionInput,
    now = performance.now(),
    wall = Date.now(),
  ) {
    this.stepDeadline = now + input.context!.budget.timeMs;
    this.decisionDeadline = Math.min(
      this.stepDeadline,
      input.modelDeadline ?? this.stepDeadline,
    );
    this.wallOffset = wall - now;
  }

  /** 剩余时间向下取整，过期返回零；不把展示精度当作新增授权。 */
  view(now = performance.now()) {
    return {
      timeMs: Math.max(0, Math.floor(this.stepDeadline - now)),
      decisionTimeMs: Math.max(0, Math.floor(this.decisionDeadline - now)),
      stepDeadlineAt: new Date(
        this.stepDeadline + this.wallOffset,
      ).toISOString(),
      decisionDeadlineAt: new Date(
        this.decisionDeadline + this.wallOffset,
      ).toISOString(),
    };
  }
}
