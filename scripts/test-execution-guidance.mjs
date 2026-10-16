import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { validateVerificationTask } from '../contracts/dist/index.js';

/** 使用显式本地控制面与节点回环夹具；不是外部网站验收，也不自动重交失败任务。 */
const origin = process.env.PROOFRUN_CONTROL_URL ?? 'http://127.0.0.1:4101';
const fixture =
  process.env.PROOFRUN_GUIDANCE_FIXTURE_URL ?? 'http://127.0.0.1:8082';
const token = process.env.PROOFRUN_ADMIN_TOKEN;
const mode = process.env.PROOFRUN_GUIDANCE_MODE ?? 'jev';
if (!token || !['llm', 'jev'].includes(mode))
  throw Error('需要管理员凭据与 llm/jev 模式');
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
  throw Error('回归脚本仅允许本地控制面');
const prefix = `guidance-${mode}-${randomUUID().slice(0, 8)}`;
const directory = `.proofrun/acceptance/${prefix}`;
await mkdir(directory, { recursive: true, mode: 0o700 });

/** 各场景分别验证不同路径，不把脚本期望值传入执行器实现。 */
const scenarios = [
  {
    name: 'long-form',
    maxActions: 22,
    objective:
      '先阅读配送说明中的配送时效和退款方式，再回到联系邮箱输入 invalid 并使输入框失焦，核对格式错误提示。禁止点击提交申请，不进行任何提交。',
    expected: [
      '展开配送时效，正文说明标准配送需要三个工作日。',
      '展开退款方式，正文说明退款原路返回。',
      '联系邮箱输入 invalid 后失焦，显示“邮箱格式不正确”。',
    ],
  },
  {
    name: 'nested',
    maxActions: 12,
    objective: '在城市列表中找到 Harbor 并选择它，核对选择结果。',
    expected: ['页面显示“已选择：Harbor”。'],
  },
  {
    name: 'wizard',
    maxActions: 12,
    objective:
      '项目名称填写 Atlas，进入下一步，勾选启用通知，再生成预览。不要重复生成预览。',
    expected: ['预览显示“项目 Atlas；通知已启用”。'],
  },
];

/** 凭据只发送给显式本地 origin，拒绝重定向。 */
async function request(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? 'POST' : 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw Error(`本地控制面 HTTP ${response.status}，请检查原任务，不自动重交`);
  return response.json();
}
/** 保存原始任务与真实调用供后续独立核查，文件不包含服务凭据。 */
async function save(name, value) {
  await writeFile(`${directory}/${name}.json`, JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
}

const results = [];
for (const scenario of scenarios) {
  const task = {
    protocolVersion: '0.1',
    taskId: `${prefix}-${scenario.name}`,
    executionMode: mode,
    objective: scenario.objective,
    target: { url: `${fixture}/${scenario.name}` },
    environment: {
      id: 'local-guidance-regression',
      nodePool: 'internal',
      reuseAuth: false,
      allowIntervention: false,
    },
    budget: { timeoutMs: 300000, maxActions: scenario.maxActions },
    acceptanceCriteria: scenario.expected.map((expectedResult, index) => ({
      id: `expected-${index + 1}`,
      description: expectedResult,
      expectedResult,
      evidenceKinds: ['DOM', 'SCREENSHOT'],
    })),
  };
  if (!validateVerificationTask(task)) throw Error('夹具任务不满足共享协议');
  await save(`${scenario.name}-submitted`, task);
  await request('/v1/tasks', task);
  console.log(JSON.stringify({ submitted: task.taskId }));
  let until = Date.now() + task.budget.timeoutMs + 120000;
  let started = false;
  let detail;
  for (;;) {
    detail = await request(`/v1/tasks/${task.taskId}`);
    // 排队时间不冒充任务运行预算；启动后仍使用原任务期限加收尾等待。
    if (!started && detail.state === 'RUNNING') {
      started = true;
      until = Date.now() + task.budget.timeoutMs + 120000;
    }
    if (
      !['QUEUED', 'RUNNING'].includes(detail.state) &&
      detail.executions.every((item) => item.closure_verified)
    )
      break;
    if (Date.now() > until)
      throw Error(`等待超时，请检查 ${task.taskId}，不会重新提交`);
    await delay(2000);
  }
  await save(`${scenario.name}-task`, detail);
  const calls = [];
  for (const execution of detail.executions) {
    const list = await request(
      `/v1/admin/executions/${execution.id}/model-calls`,
    );
    for (const call of list.calls)
      calls.push(
        await request(
          `/v1/admin/executions/${execution.id}/model-calls/${call.id}`,
        ),
      );
  }
  await save(`${scenario.name}-calls`, calls);
  results.push({
    taskId: task.taskId,
    verdict: detail.report?.verdict ?? null,
    disposition:
      detail.report?.executionDetails?.disposition ?? detail.executionOutcome,
    criteria: detail.report?.criteria,
    calls: calls.length,
    closureVerified: detail.executions.every((item) => item.closure_verified),
    diagnosticCalls: calls.filter((call) =>
      ['goal-progress-v1', 'evidence-settlement-v2'].some((version) =>
        call.request?.includes(version),
      ),
    ).length,
  });
  await save('results', results);
  console.log(JSON.stringify(results.at(-1)));
}
console.log(JSON.stringify({ directory, completed: results.length }));
if (
  results.some(
    (result) =>
      result.verdict !== 'PASSED' ||
      !result.closureVerified ||
      !result.diagnosticCalls,
  )
)
  process.exitCode = 1;
