import type { VerificationTask } from '@proofrun/contracts';
import type { PoolClient } from 'pg';
import { ApiError } from '../../domain.js';
import type { CaseDefinitionReader } from '../cases/v2.js';
import { caseRunId } from '../tasks/reader.js';

/** 仅为已有编译器提供同事务定义读取，不复制任务编译或最新运行选择规则。 */
export function transactionDefinitions(
  client: PoolClient,
): CaseDefinitionReader {
  const run = async (runId: string): Promise<VerificationTask> => {
    const row = (
      await client.query<{ definition: VerificationTask }>(
        'SELECT definition FROM pr_tasks WHERE id=$1',
        [runId],
      )
    ).rows[0];
    if (!row) throw new ApiError(404, 'TASK_MISSING', 'Task not found');
    return row.definition;
  };
  return {
    run,
    case: async (caseId, runId) => run(await caseRunId(client, caseId, runId)),
  };
}
