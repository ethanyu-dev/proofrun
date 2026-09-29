import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  validateVerificationTask,
  validateVerificationReport,
  validateTaskDetail,
} from '../contracts/dist/index.js';

/** 真环境验收只消费上层给定任务，不自造成功标准，也不自动重交未知结果的任务。 */
const MAX_BYTES = 8 * 1024 * 1024;
const POLL_MS = 1000;
const HTTP_MS = 15000;
const origin = new URL(
  process.env.PROOFRUN_CONTROL_URL ?? 'http://127.0.0.1:4100',
);
const token = process.env.PROOFRUN_ADMIN_TOKEN;
if (!token || !process.argv[2])
  throw new Error(
    '需要 PROOFRUN_ADMIN_TOKEN、PROOFRUN_CONTROL_URL 和任务 JSON 路径；另行启动配置好模型的 worker',
  );
if (
  !['http:', 'https:'].includes(origin.protocol) ||
  origin.username ||
  origin.password ||
  origin.pathname !== '/' ||
  origin.search ||
  origin.hash
)
  throw new Error('控制面必须是 HTTP(S) origin');
const task = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!validateVerificationTask(task)) throw new Error('任务不满足共享协议');
const directory = resolve(
  process.env.PROOFRUN_ACCEPTANCE_OUTPUT ?? '.proofrun/acceptance',
  task.taskId,
);
await mkdir(directory, { recursive: true, mode: 0o700 });

/** 输出证据只允许按当前控制面返回的 ID 读取，外部 URI 不携带管理员凭据。 */
async function request(path, body) {
  const response = await fetch(`${origin.origin}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(HTTP_MS),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(
      `控制面返回 HTTP ${response.status}，请查询原任务，禁止换 ID 自动重试`,
    );
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('响应超过读取上限');
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
await request('/v1/tasks', task);
const until = Date.now() + task.budget.timeoutMs + HTTP_MS;
for (;;) {
  const detail = JSON.parse(await request(`/v1/tasks/${task.taskId}`));
  if (!validateTaskDetail(detail)) throw new Error('任务详情不满足共享协议');
  if (!['QUEUED', 'RUNNING'].includes(detail.state)) {
    await writeFile(
      join(directory, 'task.json'),
      JSON.stringify(detail, null, 2),
      { mode: 0o600 },
    );
    // 会话清理独立于任务终态；待清理时继续观察，不提前宣布验收闭环完成。
    if (
      detail.executions.some((execution) => !execution.closure_verified) &&
      Date.now() < until
    ) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    const report = detail.report;
    if (report && !validateVerificationReport(report))
      throw new Error('报告不满足共享协议');
    if (report) {
      for (const artifact of report.artifacts) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(artifact.id))
          throw new Error('非法证据身份');
        const content = await request(`/v1/artifacts/${artifact.id}`);
        if (
          createHash('sha256').update(content).digest('hex') !== artifact.sha256
        )
          throw new Error('证据摘要不符');
        await writeFile(
          join(
            directory,
            `${artifact.id}.${artifact.kind === 'SCREENSHOT' ? 'png' : 'json'}`,
          ),
          content,
          { mode: 0o600 },
        );
      }
      await writeFile(
        join(directory, 'report.json'),
        JSON.stringify(report, null, 2),
        { mode: 0o600 },
      );
    }
    console.log(
      JSON.stringify({
        taskId: task.taskId,
        state: detail.state,
        verdict: report?.verdict ?? null,
        closureVerified: detail.executions.every(
          (execution) => execution.closure_verified,
        ),
        directory,
      }),
    );
    process.exitCode =
      report?.verdict === 'PASSED' &&
      detail.executions.every((execution) => execution.closure_verified)
        ? 0
        : 1;
    break;
  }
  if (Date.now() >= until)
    throw new Error('等待超时；请查询同一任务，脚本未重提交或更改任务');
  await new Promise((r) => setTimeout(r, POLL_MS));
}
