/** 收尾使用原步骤内的额度；初始估算为 45 秒，不是新增时长。 */
const INITIAL_MS = 45_000;
/** 给证据校验及持久化留出时间，不中断效果未知的浏览器命令。 */
const SAVE_MS = 1000;
/** 有界保存近期文本调用耗时，避免永久受某次异常延迟影响。 */
const SAMPLE_LIMIT = 6;

/** 只管理一次步骤内的模型时间分配，任务硬期限仍由现有预算执行器持有。 */
export class SettlementBudget {
  private samples: number[] = [];
  constructor(private readonly totalMs: number) {}
  /** 已完成及超时的文本请求均参与估计；JEV 的快速选择不稀释文本延迟。 */
  observe(elapsedMs: number) {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
    this.samples.push(elapsedMs);
    if (this.samples.length > SAMPLE_LIMIT) this.samples.shift();
  }
  /** 估计仅决定何时停止探索，不能提高原额度；短任务最多预留四成。 */
  reserve() {
    const estimate = this.samples.length
      ? Math.max(...this.samples) * 1.25
      : INITIAL_MS;
    return Math.min(this.totalMs * 0.4, estimate + SAVE_MS);
  }
  /** 需要同时容纳下一轮与一次整理；仅剩一次模型额度时直接整理。 */
  shouldSettle(timeMs: number, modelCalls: number) {
    // 下一轮按中位耗时估算，收尾保留较慢请求额度；避免一个离群慢请求被重复计算两次。
    const sorted = [...this.samples].sort((a, b) => a - b);
    const nextMs = sorted.length
      ? sorted[Math.floor(sorted.length / 2)]!
      : Math.min(INITIAL_MS, this.totalMs * 0.4);
    return timeMs <= this.reserve() + nextMs || modelCalls <= 1;
  }
  /** 探索请求不能吃掉预留额度；收尾仍需在原期限内保存结果。 */
  requestMs(timeMs: number, settling: boolean) {
    return Math.max(
      1,
      Math.floor(timeMs - (settling ? SAVE_MS : this.reserve())),
    );
  }
}
