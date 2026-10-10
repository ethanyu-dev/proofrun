import type { HitlServer, NodeCommand } from '@proofrun/contracts';

/** 服务端输入最多等待 20 秒，额外预留网络与消息派发时间。 */
export const INPUT_ACK_MS = 25_000;
/** 限制未发送动作数，避免处理者无意积累大量延迟点击。 */
const QUEUE_LIMIT = 8;
/** 与输入协议一致；连续滚动合并后仍不能超出单次范围。 */
const SCROLL_LIMIT = 2000;

/** 与控制面一致：保存登录快照不消耗动作次数，导航、输入及 Cookie 写入会消耗。 */
function usesActionBudget(command: NodeCommand['command']): boolean {
  return ['browser.act', 'browser.input', 'browser.cookies.set'].includes(
    command.type,
  );
}

/** 每个动作只发送一次，只有匹配的成功回执才允许发送后续动作。 */
interface Pending {
  /** 用于对应回执；迟到或重复回执不能释放其他动作。 */
  commandId: string;
  /** 封闭的浏览器命令，不包含任意远端脚本。 */
  command: NodeCommand['command'];
}

/** 与 React 渲染生命周期无关的串行队列，断线或超时后不重放输入。 */
export class HitlInputQueue {
  /** 尚未发送的动作；只合并相邻滚动，不跨过点击或按键。 */
  private queue: Pending[] = [];
  /** 当前唯一在途动作。 */
  private pending: Pending | null = null;
  /** 回执超时后暂停，必须由连接重建显式重置。 */
  private stopped = false;
  /** 次数耗尽属于任务状态；重连不能解除，但仍允许保存登录快照。 */
  private exhausted = false;
  /** 防止 WebSocket 仍打开却永远收不到回执。 */
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    /** 返回 false 表示连接已不可用，不能将动作留在队列等待重放。 */
    private readonly send: (item: Pending) => boolean,
    /** 同步更新页面的操作状态。 */
    private readonly changed: (busy: boolean) => void,
    /** 未确认时通知页面关闭连接并提供人工重连入口。 */
    private readonly unconfirmed: () => void,
  ) {}

  /** 是否存在在途或待发送动作，完成交接前必须全部排空。 */
  get busy() {
    return !!this.pending || this.queue.length > 0;
  }

  /** 接收动作；滚动手势产生的密集事件只占一个待发送位置。 */
  enqueue(command: NodeCommand['command']): boolean {
    if (this.stopped || (this.exhausted && usesActionBudget(command)))
      return false;
    const last = this.queue.at(-1);
    if (
      command.type === 'browser.input' &&
      command.action === 'scroll' &&
      last?.command.type === 'browser.input' &&
      last.command.action === 'scroll'
    ) {
      for (const axis of ['deltaX', 'deltaY'] as const)
        command[axis] = Math.max(
          -SCROLL_LIMIT,
          Math.min(
            SCROLL_LIMIT,
            (last.command[axis] ?? 0) + (command[axis] ?? 0),
          ),
        );
      last.command = command;
      return true;
    }
    if (this.queue.length >= QUEUE_LIMIT) return false;
    this.queue.push({ commandId: crypto.randomUUID(), command });
    this.next();
    return true;
  }

  /** 组合操作整体入队，避免容量不足时只接收 Cookie 而遗漏刷新。 */
  enqueueBatch(commands: NodeCommand['command'][]): boolean {
    if (
      this.stopped ||
      (this.exhausted && commands.some(usesActionBudget)) ||
      this.queue.length + commands.length > QUEUE_LIMIT
    )
      return false;
    this.queue.push(
      ...commands.map((command) => ({
        commandId: crypto.randomUUID(),
        command,
      })),
    );
    this.next();
    return true;
  }

  /** 只接受当前动作的回执，失败或未知结果立即停止整个队列。 */
  acknowledge(message: Extract<HitlServer, { type: 'result' }>) {
    if (message.commandId !== this.pending?.commandId) return false;
    clearTimeout(this.timer);
    this.pending = null;
    if (message.status !== 'SUCCEEDED') {
      this.stop();
      return false;
    }
    this.next();
    return !this.stopped;
  }

  /** 明确拒绝后丢弃待发操作并锁住消耗次数的动作；不关闭画面，也不把拒绝当成未知结果。 */
  exhaustActionBudget() {
    this.reset();
    this.exhausted = true;
  }

  /** 清空连接队列；只有切换到另一人工任务时才能清除次数耗尽状态。 */
  reset(newTask = false) {
    if (newTask) this.exhausted = false;
    clearTimeout(this.timer);
    this.queue = [];
    this.pending = null;
    this.stopped = false;
    this.changed(false);
  }

  /** 未确认动作不能重试，也不能因迟到回执而继续执行旧队列。 */
  private stop() {
    this.reset();
    this.stopped = true;
    this.unconfirmed();
  }

  /** 每次派发都开启独立期限，成功回执之后才消费下一项。 */
  private next() {
    if (this.pending) return;
    const item = this.queue.shift();
    if (!item) {
      this.changed(false);
      return;
    }
    this.pending = item;
    this.changed(true);
    this.timer = setTimeout(() => this.stop(), INPUT_ACK_MS);
    if (!this.send(item)) this.stop();
  }
}
