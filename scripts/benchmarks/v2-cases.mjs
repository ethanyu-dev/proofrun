import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { validateVerificationTask } from '../../contracts/dist/index.js';

/** 固定来源清单，不从网页、CLI 参数或模型回复选择任务文件。 */
export const V2_CASE_IDS = ['jiekou-referral', 'novita-site'];
/** 真实多步骤沿用 Agent 默认正文限制；基础五场景仍为 12000 字符。 */
export const V2_CONTEXT_CHARS = 64000;

/** 冻结历史任务的步骤、标准及预算，只替换本次身份和本地访客运行环境。 */
export async function v2Cases() {
  return Promise.all(
    V2_CASE_IDS.map(async (id) => {
      const source = JSON.parse(
        await readFile(
          new URL(`../../tests/benchmarks/v2/${id}.json`, import.meta.url),
          'utf8',
        ),
      );
      const digest = createHash('sha256')
        .update(JSON.stringify(source.task))
        .digest('hex');
      if (digest !== source.sourceDefinitionSha256)
        throw new Error('历史任务定义摘要不匹配');
      const task = structuredClone(source.task);
      delete task.resourceKey;
      task.taskId = `benchmark-v2-${id}-${randomUUID()}`;
      task.environment = {
        id: 'local-live-benchmark',
        nodePool: 'local-live-benchmark',
        allowIntervention: false,
      };
      if (
        task.sessionPlan?.mode !== 'guest' ||
        task.sessionPlan.candidates.length ||
        task.sessionPlan.requirements.length
      )
        throw new Error('真实站点基准仅支持无账号的访客任务');
      if (!validateVerificationTask(task))
        throw new Error('历史任务不满足当前执行协议');
      return { ...source, task };
    }),
  );
}
/** 原任务的全部模型额度含清理；不能靠额外轮次或选择重跑结果取得通过。 */
export function v2CallLimit(task) {
  return (
    task.stepBudget.steps.reduce((sum, step) => sum + step.maxModelCalls, 0) +
    (task.cleanupStepIds.length ? task.stepBudget.cleanup.maxModelCalls : 0)
  );
}
/** 每个步骤已有独立预算；宿主总寿命还覆盖既有收尾与清理窗口。 */
export function v2TimeLimit(task) {
  return (
    task.budget.timeoutMs +
    task.stepBudget.steps.length * task.stepBudget.settleMs +
    (task.cleanupStepIds.length ? task.stepBudget.cleanup.timeoutMs : 0)
  );
}
