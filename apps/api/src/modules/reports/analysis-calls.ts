import type { AnalysisCallWrite, TokenUsage } from '@proofrun/contracts';
import { Database } from '../../db.js';
import { ApiError, canonical, digest } from '../../domain.js';
import { addUsage, emptyUsage, tokenCount } from './usage.js';

/** 只接受调用身份与稳定错误码，不持久化模型正文或凭据。 */
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ERROR_CODE = /^[A-Z_]{1,80}$/;
const MAX_RUN_MS = 30 * 60_000;
const MAX_CALL_MS = 30 * 60_000;

/** 分析累计跨重跑保留；current 仅属于本次生成代次，包含该代次租约恢复。 */
export async function analysisUsage(
  db: Pick<Database, 'query'>,
  id: string,
  revision?: string,
) {
  const rows = (
    await db.query<{
      revision: string;
      prompt_tokens: string | null;
      completion_tokens: string | null;
    }>(
      'SELECT revision,prompt_tokens,completion_tokens FROM pr_analysis_calls WHERE request_id=$1 AND excluded_at IS NULL',
      [id],
    )
  ).rows;
  const current = emptyUsage();
  const cumulative = emptyUsage();
  for (const row of rows) {
    const prompt =
      row.prompt_tokens === null ? null : Number(row.prompt_tokens);
    const completion =
      row.completion_tokens === null ? null : Number(row.completion_tokens);
    addUsage(cumulative, prompt, completion);
    if (row.revision === revision) addUsage(current, prompt, completion);
  }
  return { current, cumulative } satisfies {
    current: TokenUsage;
    cumulative: TokenUsage;
  };
}

/** 登记身份固定生成代次和领取令牌，回执迟到也只能补写自己的用量。 */
export class AnalysisCalls {
  constructor(
    /** 计量写入与领取隔离在数据库事务内校验。 */
    private readonly db: Database,
  ) {}

  /** 开始记录要求有效领取，已登记调用的迟到回执只补记原用量。 */
  async write(id: string, callId: string, token: string, body: unknown) {
    if (!CALL_ID.test(callId) || !validWrite(body))
      throw new ApiError(
        400,
        'INVALID_ANALYSIS_CALL',
        '分析调用记录格式无效。',
      );
    const value = body;
    const hash = digest(canonical(value));
    return this.db.transaction(async (client) => {
      // 先锁当前分析行与入队/恢复串行化；迟到回执不要求当前代次仍运行。
      const active = (
        await client.query(
          `SELECT revision FROM pr_request_analyses WHERE request_id=$1 AND token_hash=$2
        AND status='RUNNING' AND lease_until>clock_timestamp()
        AND started_at>clock_timestamp()-($3 * interval '1 millisecond') FOR UPDATE`,
          [id, digest(token), MAX_RUN_MS],
        )
      ).rows[0];
      const previous = (
        await client.query(
          'SELECT token_hash,start_hash,finish_hash FROM pr_analysis_calls WHERE request_id=$1 AND call_id=$2 FOR UPDATE',
          [id, callId],
        )
      ).rows[0];
      if (previous && previous.token_hash !== digest(token))
        throw new ApiError(
          409,
          'ANALYSIS_LEASE_LOST',
          '分析调用不属于当前领取。',
        );
      if (value.phase === 'start' && !active)
        throw new ApiError(409, 'ANALYSIS_LEASE_LOST', '分析领取已失效。');
      const priorHash =
        value.phase === 'start' ? previous?.start_hash : previous?.finish_hash;
      if (priorHash) {
        if (priorHash !== hash)
          throw new ApiError(
            409,
            'ANALYSIS_CALL_CONFLICT',
            '分析调用记录不可改写。',
          );
        return { recorded: true };
      }
      if (value.phase === 'start') {
        await client.query(
          `INSERT INTO pr_analysis_calls(request_id,call_id,revision,token_hash,model,stage,start_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            id,
            callId,
            active.revision,
            digest(token),
            value.model,
            value.stage,
            hash,
          ],
        );
      } else {
        if (!previous)
          throw new ApiError(
            409,
            'ANALYSIS_CALL_MISSING',
            '分析调用尚未登记。',
          );
        await client.query(
          `UPDATE pr_analysis_calls SET status=$3,prompt_tokens=$4,completion_tokens=$5,
          elapsed_ms=$6,error=$7,finished_at=clock_timestamp(),finish_hash=$8 WHERE request_id=$1 AND call_id=$2`,
          [
            id,
            callId,
            value.status,
            value.promptTokens,
            value.completionTokens,
            value.elapsedMs,
            value.error,
            hash,
          ],
        );
      }
      return { recorded: true };
    });
  }
}

/** 封闭字段校验使调用记录仅承载计量事实，不成为任意日志写入入口。 */
function validWrite(value: unknown): value is AnalysisCallWrite {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (body.phase === 'start')
    return (
      Object.keys(body).every((key) =>
        ['phase', 'stage', 'model'].includes(key),
      ) &&
      ['review', 'final'].includes(String(body.stage)) &&
      typeof body.model === 'string' &&
      body.model.trim().length > 0 &&
      body.model.length <= 256
    );
  return (
    body.phase === 'finish' &&
    Object.keys(body).every((key) =>
      [
        'phase',
        'status',
        'promptTokens',
        'completionTokens',
        'elapsedMs',
        'error',
      ].includes(key),
    ) &&
    ['RECEIVED', 'ERROR'].includes(String(body.status)) &&
    [body.promptTokens, body.completionTokens].every(
      (v) => v === null || tokenCount(v) !== null,
    ) &&
    tokenCount(body.elapsedMs) !== null &&
    (body.elapsedMs as number) <= MAX_CALL_MS &&
    (body.error === null ||
      (typeof body.error === 'string' && ERROR_CODE.test(body.error))) &&
    (body.status !== 'ERROR' ||
      (body.promptTokens === null && body.completionTokens === null))
  );
}
