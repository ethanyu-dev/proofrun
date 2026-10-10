import { consumeStepBudget } from '../scheduling/step-budget.js';
import type { ModelCall, ModelCallWrite } from '@proofrun/contracts';
import { Database } from '../../db.js';
import { ApiError, canonical, digest, ID_PATTERN } from '../../domain.js';
import { executionContext } from '../scheduling/state.js';

/** 列表只读元数据，展开单次调用时才加载可能很长的正文。 */
const CALL_LIMIT = 20_000;
/** 仅允许实际模型正文参数；禁止存入请求地址、认证头或任意供应商扩展。 */
const REQUEST_FIELDS = new Set([
  'model',
  'stream',
  'parallel_tool_calls',
  'max_tokens',
  'max_completion_tokens',
  'messages',
  'tools',
  'tool_choice',
  'response_format',
  'state',
  'questions',
  'thinking',
]);

/** 请求在派发前存档，回复只允许补写一次；相同身份重送不能改写原始上下文。 */
export class ModelCalls {
  constructor(private readonly db: Database) {}

  /** 执行凭据只允许写入自己的记录；结束后可以补交已有调用的回执。 */
  async write(
    executionId: string,
    id: string,
    token: string,
    body: ModelCallWrite,
  ) {
    if (!ID_PATTERN.test(id))
      throw new ApiError(
        400,
        'INVALID_MODEL_CALL',
        'Invalid model call identity',
      );
    return this.db.transaction(async (client) => {
      const context = await executionContext(client, executionId);
      if (digest(token) !== context.token_hash)
        throw new ApiError(401, 'UNAUTHORIZED', 'Invalid execution credential');
      const task = await client.query(
        'SELECT archived_at FROM pr_tasks WHERE id=$1',
        [context.task_id],
      );
      if (task.rows[0].archived_at)
        throw new ApiError(
          409,
          'MODEL_CALL_ARCHIVED',
          'Model call content has been archived',
        );
      const previous = await client.query<{
        record: ModelCall;
        start_hash: string;
        finish_hash: string | null;
      }>(
        'SELECT record,start_hash,finish_hash FROM pr_model_calls WHERE execution_id=$1 AND id=$2',
        [executionId, id],
      );
      const row = previous.rows[0];
      const hash = digest(canonical(body));
      if (body.phase === 'start') {
        if (row) {
          if (row.start_hash !== hash)
            throw new ApiError(
              409,
              'MODEL_CALL_CONFLICT',
              'Model call identity is already bound',
            );
          return { recorded: true };
        }
        const record = body.record;
        if (
          record.id !== id ||
          record.status !== 'PENDING' ||
          record.archived ||
          record.request === null ||
          record.finishedAt !== null ||
          record.response !== null ||
          record.error !== null ||
          record.elapsedMs !== null ||
          record.promptTokens !== null ||
          record.completionTokens !== null
        )
          throw new ApiError(
            400,
            'INVALID_MODEL_CALL',
            'Invalid initial model call',
          );
        if (
          context.task_state !== 'RUNNING' ||
          context.execution_state !== 'RUNNING' ||
          context.lease_expires_at.getTime() <= Date.now() ||
          context.deadline_at.getTime() <= Date.now()
        )
          throw new ApiError(
            409,
            'EXECUTION_EXPIRED',
            'Active execution required for a new model call',
          );
        // 只接收可解析的供应商请求正文，不接收 URL、HTTP 请求头或认证配置。
        let request: Record<string, unknown>;
        try {
          request = JSON.parse(record.request);
        } catch {
          throw new ApiError(400, 'INVALID_MODEL_CALL', 'Invalid request JSON');
        }
        if (
          !request ||
          typeof request !== 'object' ||
          Array.isArray(request) ||
          Object.keys(request).some((key) => !REQUEST_FIELDS.has(key))
        )
          throw new ApiError(
            400,
            'INVALID_MODEL_CALL',
            'Unexpected request fields',
          );
        // 思考参数必须是封闭对象，不能借新字段夹带认证配置或其他扩展。
        if ('thinking' in request) {
          const thinking = request.thinking;
          if (
            !thinking ||
            typeof thinking !== 'object' ||
            Array.isArray(thinking) ||
            Object.keys(thinking).length !== 1 ||
            !('type' in thinking) ||
            (thinking.type !== 'enabled' && thinking.type !== 'disabled')
          )
            throw new ApiError(
              400,
              'INVALID_MODEL_CALL',
              'Invalid thinking parameter',
            );
        }
        await consumeStepBudget(client, context, 'modelCalls');
        const inserted = await client.query(
          'INSERT INTO pr_model_calls(id,execution_id,call_index,record,start_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
          [id, executionId, record.callIndex, JSON.stringify(record), hash],
        );
        if (!inserted.rowCount)
          throw new ApiError(
            409,
            'MODEL_CALL_CONFLICT',
            'Model call order or identity is already bound',
          );
      } else {
        if (!row)
          throw new ApiError(
            404,
            'MODEL_CALL_MISSING',
            'Record request before response',
          );
        if (row.finish_hash) {
          if (row.finish_hash !== hash)
            throw new ApiError(
              409,
              'MODEL_CALL_CONFLICT',
              'Model call response is immutable',
            );
          return { recorded: true };
        }
        const result = body.result;
        if (
          !result.finishedAt ||
          result.status === 'PENDING' ||
          result.elapsedMs === null ||
          (result.status === 'ERROR'
            ? !result.error || result.response !== null
            : result.error !== null || result.response === null)
        )
          throw new ApiError(
            400,
            'INVALID_MODEL_CALL',
            'Invalid model call receipt',
          );
        if (result.response !== null) {
          try {
            JSON.parse(result.response);
          } catch {
            throw new ApiError(
              400,
              'INVALID_MODEL_CALL',
              'Invalid response JSON',
            );
          }
        }
        await client.query(
          'UPDATE pr_model_calls SET record=record || $3::jsonb,finish_hash=$4 WHERE execution_id=$1 AND id=$2',
          [executionId, id, JSON.stringify(result), hash],
        );
      }
      return { recorded: true };
    });
  }

  /** 管理员列表不携带页面正文，避免轮询反复传输全部上下文。 */
  async list(executionId: string) {
    const exists = await this.db.query(
      'SELECT 1 FROM pr_executions WHERE id=$1',
      [executionId],
    );
    if (!exists.rowCount)
      throw new ApiError(404, 'EXECUTION_MISSING', 'Execution not found');
    const result = await this.db.query(
      "SELECT record-'request'-'response' AS record FROM pr_model_calls WHERE execution_id=$1 ORDER BY call_index LIMIT $2",
      [executionId, CALL_LIMIT],
    );
    return { calls: result.rows.map((row) => row.record) };
  }

  /** 单次原文始终绑定执行身份；旧任务没有记录时不会伪造重建上下文。 */
  async read(executionId: string, id: string) {
    const result = await this.db.query(
      'SELECT record FROM pr_model_calls WHERE execution_id=$1 AND id=$2',
      [executionId, id],
    );
    if (!result.rows[0])
      throw new ApiError(404, 'MODEL_CALL_MISSING', 'Model call not found');
    return result.rows[0].record as ModelCall;
  }
}
