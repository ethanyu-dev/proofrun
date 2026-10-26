import { readFile } from 'node:fs/promises';
import { validateVerificationTask } from '@proofrun/contracts';
import { loadConfig } from './config.js';
import { AgentFault } from './http.js';
import { runWorker } from './worker.js';

/** CLI 只管理 worker 进程；浏览器创建、清理与并发额度始终由控制面和 Node 管理。 */
const USAGE = 'Usage: proofrun-agent validate <task.json> | once | serve';
const [command, input, ...extra] = process.argv.slice(2);

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
    await runWorker(loadConfig(), command === 'once');
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
