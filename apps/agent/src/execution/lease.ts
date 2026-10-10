import type { ExecutionGrant } from '@proofrun/contracts';
import type { ControlClient, ExecutionTiming } from '../client.js';
import { AgentFault, pause } from '../http.js';

/** 避免极短租约形成忙循环；续期频率始终快于正常租约的三分之一。 */
const MIN_HEARTBEAT_MS = 25;

/** 续租与模型调用并行，但过期定时器独立运行，挂住的 HTTP 不能延长执行权。 */
export class LeaseGuard {
  /** 浏览器命令和模型调用必须共同服从此撤销信号。 */
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly heartbeat: Promise<void>;
  private leaseTimer: ReturnType<typeof setTimeout> | undefined;
  private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  private deadline: number;
  /** 仅接受新控制代次，防止慢心跳覆盖已确认的暂停或恢复。 */
  private revision = 0;
  private paused = false;
  private deadlineAt: string;
  /** 一旦进入清理，只接受携带同一清理期限的后续时间快照。 */
  private cleanupDeadlineAt: string | undefined;

  constructor(
    client: Pick<ControlClient, 'heartbeat'>,
    execution: ExecutionGrant,
    stop: AbortSignal,
    private readonly timing?: (view: ExecutionTiming) => void,
  ) {
    this.signal = AbortSignal.any([stop, this.controller.signal]);
    this.deadlineAt = execution.taskDeadlineAt;
    this.deadline =
      performance.now() +
      Math.max(0, Date.parse(execution.taskDeadlineAt) - Date.now());
    this.deadlineTimer = setTimeout(
      () => this.fail('TASK_DEADLINE', '任务总时限已到'),
      this.remaining(),
    );
    this.arm(execution.leaseExpiresAt);
    const signal = this.signal;
    this.heartbeat = (async () => {
      let expires = execution.leaseExpiresAt;
      while (!signal.aborted) {
        await pause(
          Math.max(
            MIN_HEARTBEAT_MS,
            Math.min(5000, (Date.parse(expires) - Date.now()) / 3),
          ),
          signal,
        );
        const reply = await client.heartbeat(execution, signal);
        // 回复到达时可能已经被原期限撤权；迟到响应绝不重启一个失效执行。
        signal.throwIfAborted();
        if (!this.syncTiming(reply)) continue;
        expires = reply.leaseExpiresAt;
      }
    })().catch(() => {
      if (!this.signal.aborted)
        this.fail('LEASE_LOST', '控制面续租失败，已停止执行');
    });
  }
  /** 只接受控制面确认的期限；清理使用固定墙钟预算，旧心跳不能退回业务阶段。 */
  syncTiming(view: ExecutionTiming): boolean {
    if (
      this.signal.aborted ||
      (view.controlRevision !== undefined &&
        view.controlRevision < this.revision) ||
      (this.cleanupDeadlineAt !== undefined &&
        view.cleanupDeadlineAt !== this.cleanupDeadlineAt)
    )
      return false;
    this.timing?.(view);
    if (!view.controlMode || view.controlRevision === undefined) {
      if (view.leaseExpiresAt) this.arm(view.leaseExpiresAt);
      return true;
    }
    if (view.cleanupDeadlineAt) this.cleanupDeadlineAt = view.cleanupDeadlineAt;
    const paused = !this.cleanupDeadlineAt && view.controlMode !== 'AUTO';
    const deadlineAt =
      this.cleanupDeadlineAt ?? view.taskDeadlineAt ?? this.deadlineAt;
    if (!Number.isFinite(Date.parse(deadlineAt))) {
      this.fail('INVALID_EXECUTION_VIEW', '执行截止时间无效');
      return false;
    }
    if (this.paused === paused && this.deadlineAt === deadlineAt) {
      this.revision = view.controlRevision;
      if (view.leaseExpiresAt) this.arm(view.leaseExpiresAt);
      return true;
    }
    this.revision = view.controlRevision;
    this.paused = paused;
    this.deadlineAt = deadlineAt;
    clearTimeout(this.deadlineTimer);
    this.deadline = paused
      ? Infinity
      : performance.now() + Math.max(0, Date.parse(deadlineAt) - Date.now());
    if (!paused)
      this.deadlineTimer = setTimeout(
        () =>
          this.fail(
            this.cleanupDeadlineAt
              ? 'CLEANUP_DEADLINE_EXCEEDED'
              : 'TASK_DEADLINE',
            this.cleanupDeadlineAt
              ? '后续清理超过三分钟预算'
              : '任务总时限已到',
          ),
        this.remaining(),
      );
    if (view.leaseExpiresAt) this.arm(view.leaseExpiresAt);
    return true;
  }
  /** 自动执行使用单调时钟；暂停期间仍保留独立的 worker 租约计时器。 */
  remaining(): number {
    return Math.max(0, this.deadline - performance.now());
  }
  private fail(code: string, message: string): void {
    this.controller.abort(new AgentFault(code, message));
  }
  private arm(expires: string): void {
    clearTimeout(this.leaseTimer);
    const remaining = Date.parse(expires) - Date.now();
    if (remaining <= 0) {
      this.fail('LEASE_LOST', '执行租约已过期');
      return;
    }
    this.leaseTimer = setTimeout(
      () =>
        this.cleanupDeadlineAt &&
        Date.parse(this.cleanupDeadlineAt) <= Date.now()
          ? this.fail('CLEANUP_DEADLINE_EXCEEDED', '后续清理超过三分钟预算')
          : this.fail('LEASE_LOST', '执行租约已过期'),
      remaining,
    );
  }
  /** 等待后台续租结束，避免任务结束后留下后台请求和计时器。 */
  async close(): Promise<void> {
    this.controller.abort(new AgentFault('EXECUTION_CLOSED', '执行已结束'));
    clearTimeout(this.leaseTimer);
    clearTimeout(this.deadlineTimer);
    await this.heartbeat;
  }
}
