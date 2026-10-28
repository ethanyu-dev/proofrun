export {
  ExecutionFault as AgentFault,
  transient,
} from '@proofrun/execution-core/faults';
/** 可取消等待，关停或租约失效时不再继续下一次领取或浏览器动作。 */
export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
