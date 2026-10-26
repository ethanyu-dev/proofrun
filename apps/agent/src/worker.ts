import { randomUUID } from 'node:crypto';
import type { ExecutionGrant } from '@proofrun/contracts';
import { ControlClient } from './client.js';
import type { AgentConfig } from './config.js';
import { execute } from './execution/runner.js';
import { AgentFault, pause } from './http.js';
import { ChatModel } from './model/chat.js';

/** workerId 最长 128 字符，为分隔符和每次领取的 UUID 留出空间。 */
const WORKER_PREFIX_LENGTH = 91;

/** 每个授权独立执行、续租和提交报告；人工等待不阻塞其他任务的领取。 */
async function runExecution(
  config: AgentConfig,
  client: ControlClient,
  grant: ExecutionGrant,
  signal: AbortSignal,
): Promise<void> {
  const report = await execute(
    config,
    client,
    new ChatModel(config),
    grant,
    signal,
  );
  console.log(
    JSON.stringify({
      event: 'execution.reported',
      taskId: grant.task.taskId,
      executionId: grant.id,
      disposition: report.executionDisposition,
      verdict: report.verdict,
      reasonCode: report.executionDetails?.reasonCode,
    }),
  );
}

/** 持续串行申请授权，执行并行推进；控制面和节点决定能否创建新会话，不在 Agent 中排队。 */
export async function runWorker(
  config: AgentConfig,
  once: boolean,
): Promise<void> {
  const controller = new AbortController();
  // 只保留尚未完成的执行，关停时统一撤权并等待各自报告与租约清理。
  const active = new Set<Promise<void>>();
  const stop = () =>
    controller.abort(new AgentFault('WORKER_STOPPED', 'worker 正在关停'));
  /** 一个执行失败不影响其他授权；日志只记录脱敏后的错误分类。 */
  const failed = (error: unknown) => {
    if (controller.signal.aborted) return;
    console.error(
      JSON.stringify({
        event: 'worker.error',
        code: error instanceof AgentFault ? error.code : 'WORKER_ERROR',
      }),
    );
    if (once) process.exitCode = 1;
  };
  // 监听器按进程登记，数量不随活动任务增长。
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!controller.signal.aborted) {
      try {
        // 包括回执丢失后的下一次领取，都使用新身份；旧授权只由其租约回收。
        const executionConfig = {
          ...config,
          workerId: `${config.workerId.slice(0, WORKER_PREFIX_LENGTH)}-${randomUUID()}`,
        };
        const client = new ControlClient(executionConfig);
        const grant = await client.claim(controller.signal);
        // 关停期间迟到的领取回执不能启动新的执行。
        if (controller.signal.aborted) break;
        if (grant) {
          const pending = runExecution(
            executionConfig,
            client,
            grant,
            controller.signal,
          )
            .catch(failed)
            .finally(() => active.delete(pending));
          active.add(pending);
          if (once) await pending;
        } else if (once) console.log(JSON.stringify({ event: 'queue.empty' }));
      } catch (error) {
        failed(error);
      }
      if (once) break;
      // 成功、空队列和领取失败都按同一频率轮询，避免快速创建或故障重试打满控制面。
      await pause(config.pollMs, controller.signal).catch(() => {});
    }
  } finally {
    stop();
    await Promise.allSettled(active);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
