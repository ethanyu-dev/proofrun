import { Agent, buildConnector } from 'undici';

/** 模型连接与整次请求共享调用方计算的剩余时限，不额外套用 fetch 隐含的十秒连接上限。 */
export function modelTransport(timeoutMs: number, signal: AbortSignal): Agent {
  // 连接尚未建立时单独 destroy dispatcher 不足以关闭在途 socket，取消信号必须传给底层连接器。
  // 每次请求独占连接，避免取消一个任务时关闭其他任务的连接；jsonRequest 负责最终销毁。
  return new Agent({ connect: buildConnector({ timeout: timeoutMs, signal }) });
}
