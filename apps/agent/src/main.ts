import { readFile } from 'node:fs/promises';
import { validateVerificationTask } from '@proofrun/contracts';
import { ControlClient } from './client.js';
import { loadConfig } from './config.js';
import { execute } from './execution/runner.js';
import { AgentFault, pause } from './http.js';
import { ChatModel } from './model/chat.js';
import { JevModel } from './model/jev.js';
import { executionStrategy } from './model/strategy.js';

/** CLI 只管理 worker 进程；浏览器创建、清理与并发额度始终由控制面和 Node 管理。 */
const USAGE = 'Usage: proofrun-agent validate <task.json> | once | serve';
const [command, input, ...extra] = process.argv.slice(2);

/** 领取响应丢失时不复用未知授权；控制面按租约回收，下一轮正常轮询队列。 */
async function worker(once: boolean, slot: number): Promise<void> {
  const config = loadConfig();
  // 显式指定身份时也按槽区分，避免并发领取共享 worker 标识。
  if (process.env.PROOFRUN_WORKER_ID)
    config.workerId = `${config.workerId.slice(0, 100)}-${slot + 1}`;
  const client = new ControlClient(config);
  const controller = new AbortController();
  const stop = () =>
    controller.abort(new AgentFault('WORKER_STOPPED', 'worker 正在关停'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!controller.signal.aborted) {
      try {
        const grant = await client.claim(controller.signal);
        if (grant) {
          const jev = executionStrategy(grant.task) === 'jev';
          const model = jev
            ? new JevModel(
                config,
                process.env.TYPESAFE_API_KEY ?? '',
                process.env.TYPESAFE_MODEL,
              )
            : new ChatModel(config);
          const report = await execute(
            {
              ...config,
              model: jev
                ? `JEV (${process.env.TYPESAFE_MODEL ?? 'jev-latest'}) + ${config.model}`
                : config.model,
            },
            client,
            model,
            grant,
            controller.signal,
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
        } else if (once) console.log(JSON.stringify({ event: 'queue.empty' }));
      } catch (error) {
        if (controller.signal.aborted) break;
        console.error(
          JSON.stringify({
            event: 'worker.error',
            code: error instanceof AgentFault ? error.code : 'WORKER_ERROR',
          }),
        );
        if (once) process.exitCode = 1;
      }
      if (once) break;
      await pause(config.pollMs, controller.signal).catch(() => {});
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

try {
  if (command === '--help' || command === undefined) console.log(USAGE);
  else if (command === 'validate' && input && extra.length === 0) {
    const task: unknown = JSON.parse(await readFile(input, 'utf8'));
    if (!validateVerificationTask(task)) {
      console.error(
        JSON.stringify(
          { valid: false, errors: validateVerificationTask.errors },
          null,
          2,
        ),
      );
      process.exitCode = 1;
    } else
      console.log(
        JSON.stringify(
          { valid: true, taskId: task.taskId, executed: false },
          null,
          2,
        ),
      );
  } else if ((command === 'serve' || command === 'once') && !input) {
    // 每个槽拥有独立领取身份、租约和执行上下文，节点容量仍是更硬的上限。
    const concurrency = Number(process.env.PROOFRUN_AGENT_CONCURRENCY ?? 1);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
      throw new Error('Invalid concurrency');
    await Promise.all(
      Array.from({ length: command === 'once' ? 1 : concurrency }, (_, slot) =>
        worker(command === 'once', slot),
      ),
    );
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (error) {
  // 配置错误不打印可能嵌有凭据的 URL，也不打印整个环境变量。
  console.error(
    error instanceof AgentFault
      ? error.code
      : '启动或输入失败，请检查命令参数与配置',
  );
  process.exitCode = 1;
}
