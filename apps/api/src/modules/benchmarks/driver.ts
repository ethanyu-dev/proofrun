import { randomUUID } from 'node:crypto';
import type { ExecutionGrant } from '@proofrun/contracts';
import type { ExecutionClient } from '@proofrun/execution-driver/execution/runner';
import type { BenchmarkCommand } from '@proofrun/contracts/benchmark';
import type { Benchmarks } from './service.js';

/** 故障只在数据库登记的合成场景中注入；业务任务走原端口，不能通过任务文本触发。 */
export function benchmarkPorts(
  service: Benchmarks,
  grant: ExecutionGrant,
  ports: ExecutionClient,
): ExecutionClient {
  let lookup: Promise<any> | undefined;
  const scenario = () =>
    (lookup ??= service.db
      .query('SELECT * FROM pr_benchmark_cases WHERE task_id=$1', [
        grant.task.taskId,
      ])
      .then((result) => result.rows[0]));
  return {
    ...ports,
    command: async (...args) => {
      const row = await scenario();
      if (!row) return ports.command(...args);
      await service.db.query(
        'UPDATE pr_benchmark_cases SET api_release=coalesce(api_release,$2) WHERE task_id=$1',
        [row.task_id, service.release],
      );
      const [
        execution,
        commandId,
        operation,
        timeoutMs,
        signal,
        revision,
        stepId,
      ] = args;
      const decisionIndex = Number(
        (
          await service.db.query(
            "SELECT record->>'decisionIndex' AS n FROM pr_model_calls WHERE execution_id=$1 ORDER BY call_index DESC LIMIT 1",
            [grant.id],
          )
        ).rows[0]?.n ?? 0,
      );
      const invoke = async (
        id: string,
        command: typeof operation,
        fault?: string,
      ) => {
        const record: BenchmarkCommand = {
          decisionIndex,
          operation: { ...command },
          status: 'PENDING',
          effect: 'NOT_STARTED',
          ...(fault ? { origin: 'fault-injection', fault } : {}),
        };
        await service.db.query(
          'INSERT INTO pr_benchmark_commands(command_id,task_id,record) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [id, row.task_id, record],
        );
        try {
          const result = await ports.command(
            execution,
            id,
            command,
            timeoutMs,
            signal,
            revision,
            stepId,
          );
          record.status = result.operationStatus;
          record.effect = result.effect;
          record.result = result.data ?? {};
          if (result.error) record.error = result.error.code;
          if (result.error?.code === 'STALE_OBSERVATION')
            await service.db.query(
              'UPDATE pr_benchmark_cases SET stale_rejected=true WHERE task_id=$1',
              [row.task_id],
            );
          if (
            row.scenario === 'unknown-write' &&
            !row.injected &&
            result.operationStatus === 'SUCCEEDED' &&
            command.type === 'browser.act' &&
            ['click', 'visual.click', 'press'].includes(command.action)
          ) {
            let writes = 0;
            for (let attempt = 0; attempt < 20; attempt++) {
              writes = Number(
                (
                  await service.db.query(
                    'SELECT jsonb_array_length(writes) AS n FROM pr_benchmark_cases WHERE task_id=$1',
                    [row.task_id],
                  )
                ).rows[0]!.n,
              );
              if (writes) break;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            if (writes) {
              row.injected = true;
              await service.db.query(
                'UPDATE pr_benchmark_cases SET injected=true WHERE task_id=$1',
                [row.task_id],
              );
              record.nativeStatus = result.operationStatus;
              record.fault = '真实写入完成后注入回执丢失';
              record.status = 'UNKNOWN';
              record.effect = 'MAY_HAVE_HAPPENED';
            }
          }
          await service.db.query(
            'UPDATE pr_benchmark_commands SET record=$2 WHERE command_id=$1',
            [id, record],
          );
          return record.fault === '真实写入完成后注入回执丢失'
            ? {
                ...result,
                operationStatus: 'UNKNOWN' as const,
                effect: 'MAY_HAVE_HAPPENED' as const,
                data: {},
              }
            : result;
        } catch (error) {
          record.status = 'ERROR';
          record.error = 'COMMAND_DELIVERY_FAILED';
          await service.db.query(
            'UPDATE pr_benchmark_commands SET record=$2 WHERE command_id=$1',
            [id, record],
          );
          throw error;
        }
      };
      if (
        row.scenario === 'invalid-target' &&
        !row.injected &&
        operation.type === 'browser.act' &&
        'observationId' in operation &&
        operation.observationId
      ) {
        row.injected = true;
        await service.db.query(
          'UPDATE pr_benchmark_cases SET injected=true WHERE task_id=$1',
          [row.task_id],
        );
        const observed = await invoke(
          randomUUID(),
          { type: 'browser.observe' },
          '主动刷新真实观察使旧目标失效',
        );
        if (observed.operationStatus !== 'SUCCEEDED')
          throw new Error('旧观察故障注入失败');
      }
      return invoke(commandId, operation);
    },
  };
}
