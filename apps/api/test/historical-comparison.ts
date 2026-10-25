import type { VerificationTask } from '@proofrun/contracts';
import { canonical, digest } from '../src/domain.js';

/** 只供历史读取测试导入旧双跑数据，不能通过已退役的新建接口生成；不启动执行器。 */
export async function seedHistoricalPair(
  sql: { query: (...args: any[]) => Promise<any> },
  primaryId: string,
  sourceTaskId = primaryId,
) {
  const row = (
    await sql.query('SELECT definition FROM pr_tasks WHERE id=$1', [primaryId])
  ).rows[0];
  if (!row) return;
  const original = row.definition as VerificationTask;
  // 先保存从组再公开主组的双跑标记，避免并发读取看到缺少从组的半份夹具。
  if (!row.definition.comparison)
    for (const arm of ['jev', 'llm'] as const) {
      const definition = {
        ...structuredClone(original),
        taskId: arm === 'llm' ? primaryId : `comparison-${primaryId}-jev`,
        executionMode: arm,
        comparison: { id: primaryId, sourceTaskId, arm },
      };
      const hash = digest(canonical(definition));
      if (arm === 'llm')
        await sql.query(
          'UPDATE pr_tasks SET definition=$2,definition_hash=$3 WHERE id=$1',
          [primaryId, definition, hash],
        );
      else
        await sql.query(
          'INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at) SELECT $2,$3,$4,state,deadline_at FROM pr_tasks WHERE id=$1 ON CONFLICT DO NOTHING',
          [primaryId, definition.taskId, definition, hash],
        );
    }
  await sql.query(
    "INSERT INTO pr_verification_request_arms(request_id,case_id,execution_mode,task_id) SELECT request_id,case_id,'jev',$2 FROM pr_verification_request_cases WHERE task_id=$1 ON CONFLICT DO NOTHING",
    [primaryId, `comparison-${primaryId}-jev`],
  );
}
