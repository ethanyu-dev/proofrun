import {
  BASIC_INTERACTIONS,
  basicInteractionObjective,
  basicInteractionPage,
} from './benchmark-interactions.js';
import type { VerificationTask } from './generated/verification-task.js';

/** 线上套件与本地隔离套件分开版本，避免把部署链路指标与进程内适配混为一谈。 */
export const DEPLOYED_BENCHMARK_SUITE = 'agent-loop-deployed-v2';
/** 历史五场景继续按原集合归档，不能因新增场景使旧运行无法结算。 */
export const LEGACY_DEPLOYED_BENCHMARK_SUITE = 'agent-loop-deployed-v1';
/** 每例固定预算，API 与 Agent 共用，避免 worker 配置改变测量条件。 */
export const BENCHMARK_LIMITS = {
  maxTurns: 12,
  maxContextChars: 12000,
  timeoutMs: 180000,
  maxActions: 10,
  commandMs: 20000,
  evidenceMs: 30000,
};
export const BENCHMARK_SCENARIOS = [
  { id: 'form-submit', name: '真实表单填写与单次提交' },
  { id: 'read-only', name: '真实页面只读核验' },
  { id: 'invalid-target', name: '旧观察拒绝与模型恢复' },
  { id: 'unknown-write', name: '真实写入后丢回执保护' },
  { id: 'context-pressure', name: '真实长页面上下文裁剪' },
  ...BASIC_INTERACTIONS,
] as const;
/** 固定合成业务页面，不接受页面模板、外部地址、代码或账号输入。 */
export function benchmarkPage(id: string): string {
  const head =
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>基础基准</title><style>body{font:16px sans-serif;max-width:720px;margin:40px auto}label{display:block;margin:16px 0}input,button{padding:10px}</style>';
  const interaction = basicInteractionPage(id);
  if (interaction) return head + interaction + '</html>';
  if (id === 'read-only')
    return (
      head +
      '<h1>系统状态</h1><p>当前状态：已就绪</p><p>状态编号：READY-2026</p></html>'
    );
  const form =
    '<h1>提交测试资料</h1><form><label>姓名<input name="name" required></label><label>城市<input name="city" required></label><button type="submit">保存资料</button></form><p role="status">尚未提交</p>';
  const long =
    id === 'context-pressure'
      ? '<section><h2>辅助资料</h2><p>' +
        '这是一段与表单操作无关的辅助说明，保存表单请使用上方控件。'.repeat(
          1600,
        ) +
        '</p></section>'
      : '';
  return (
    head +
    form +
    long +
    `<script>document.querySelector('form').onsubmit=async event=>{event.preventDefault();const response=await fetch(location.pathname+'/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(event.target)))});const result=await response.json();document.querySelector('[role=status]').textContent='已保存：'+result.name+' / '+result.city+'；保存次数 '+result.count;};</script></html>`
  );
}
/** 任务只使用合成资料、访客会话及固定预算，既有登录态不会被带入基准。 */
export function benchmarkTask(
  id: string,
  scenario: string,
  url: string,
  pool: string,
): VerificationTask {
  const readOnly = scenario === 'read-only';
  const interaction = basicInteractionObjective(scenario);
  return {
    protocolVersion: '0.1',
    taskId: id,
    executionMode: 'llm',
    ...(interaction ? { taskKind: 'browser' as const } : {}),
    objective:
      interaction ??
      (readOnly
        ? '只读取当前页面，核对当前状态为已就绪且状态编号为 READY-2026，不执行任何写入。'
        : '将姓名填写为 Alice，城市填写为 Hangzhou，保存资料一次，核对已保存 Alice / Hangzhou 且保存次数为 1。不要重复提交。'),
    environment: {
      id: 'deployed-benchmark',
      nodePool: pool,
      allowIntervention: false,
    },
    target: { url },
    sessionPlan: {
      version: 1,
      mode: 'guest',
      profileSource: 'empty',
      candidates: [],
      requirements: [],
      preparationMs: 30000,
    },
    acceptanceCriteria: interaction
      ? []
      : [
          {
            id: 'result',
            description: readOnly ? '状态核验' : '保存结果核验',
            expectedResult: readOnly
              ? '当前状态：已就绪，状态编号：READY-2026'
              : '已保存：Alice / Hangzhou；保存次数 1',
            evidenceKinds: ['DOM'],
          },
        ],
    budget: {
      timeoutMs: BENCHMARK_LIMITS.timeoutMs,
      maxActions: BENCHMARK_LIMITS.maxActions,
    },
  };
}

/** V2 保持本地完整任务的正文、命令与证据预算；基础套件额度不变。 */
export const V2_CONTEXT_CHARS = 64000;
export type BenchmarkFamily = 'browser' | 'v2';
/** 原任务全部步骤与清理的模型额度，不提供额外重试额度。 */
export function v2CallLimit(task: VerificationTask): number {
  if (!task.stepBudget) throw new Error('V2 缺少原步骤预算');
  return (
    task.stepBudget.steps.reduce((sum, step) => sum + step.maxModelCalls, 0) +
    (task.cleanupStepIds?.length ? task.stepBudget.cleanup.maxModelCalls : 0)
  );
}
/** 宿主寿命覆盖原任务及已有步骤收尾、清理窗口，不修改任务内的逐步预算。 */
export function v2TimeLimit(task: VerificationTask): number {
  if (!task.stepBudget) throw new Error('V2 缺少原步骤预算');
  return (
    task.budget.timeoutMs +
    task.stepBudget.steps.length * task.stepBudget.settleMs +
    (task.cleanupStepIds?.length ? task.stepBudget.cleanup.timeoutMs : 0)
  );
}
/** Agent 与服务端分别从授权及数据库的测试集选择同一固定配置。 */
export function benchmarkRuntimeLimits(
  family: BenchmarkFamily,
  task: VerificationTask,
) {
  return family === 'v2'
    ? {
        maxTurns: v2CallLimit(task),
        maxContextChars: V2_CONTEXT_CHARS,
        commandMs: 20000,
        evidenceMs: 5000,
      }
    : {
        maxTurns: BENCHMARK_LIMITS.maxTurns,
        maxContextChars: BENCHMARK_LIMITS.maxContextChars,
        commandMs: BENCHMARK_LIMITS.commandMs,
        evidenceMs: BENCHMARK_LIMITS.evidenceMs,
      };
}
