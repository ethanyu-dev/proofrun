import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateVerificationTask } from './index.js';
import type { VerificationTask } from './generated/verification-task.js';

/** 固定历史来源随 contracts 发布；服务端不接受任务文件路径或任意站点。 */
export const V2_CASE_IDS = ['jiekou-referral', 'novita-site'] as const;
/** 保存历史定义摘要和来源；实际执行只替换身份与访客环境。 */
export interface V2BenchmarkScenario {
  /** 跨运行匹配的固定场景身份。 */
  id: string;
  /** 看板显示的历史任务名称。 */
  name: string;
  /** 原始执行身份，仅用于追溯，不复用旧运行。 */
  sourceTaskId: string;
  /** 来源归档的创建时间。 */
  sourceCreatedAt: string;
  /** 未替换身份前的历史任务正文摘要。 */
  sourceDefinitionSha256: string;
  /** 原始结论，不作为新运行通过的依据。 */
  historicalVerdict: string;
  /** 本次冻结输入，保留原步骤和额度。 */
  task: VerificationTask;
}
/** 本地与线上使用同一份固定定义，不复制预算或删减无法验证的步骤。 */
export function v2BenchmarkCases(
  identity: (id: string) => string,
  environment: VerificationTask['environment'],
): V2BenchmarkScenario[] {
  return V2_CASE_IDS.map((id) => {
    const source = JSON.parse(
      readFileSync(
        new URL(`../fixtures/benchmark-v2/${id}.json`, import.meta.url),
        'utf8',
      ),
    );
    if (
      createHash('sha256').update(JSON.stringify(source.task)).digest('hex') !==
      source.sourceDefinitionSha256
    )
      throw new Error('历史任务定义摘要不匹配');
    const task = source.task;
    delete task.resourceKey;
    task.taskId = identity(id);
    task.environment = { ...environment, allowIntervention: false };
    if (
      task.sessionPlan?.mode !== 'guest' ||
      task.sessionPlan.candidates.length ||
      task.sessionPlan.requirements.length
    )
      throw new Error('真实站点基准仅支持无账号的访客任务');
    if (!validateVerificationTask(task))
      throw new Error('历史任务不满足当前执行协议');
    return { ...source, task };
  });
}
