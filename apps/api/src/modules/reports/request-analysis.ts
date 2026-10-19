import { randomUUID } from 'node:crypto';
import {
  requestCaseArm,
  requestVerification,
  type RequestAnalysis,
  type RequestResultV2,
  type AnalysisContextPage,
} from '@proofrun/contracts';
import { Database } from '../../db.js';
import { ApiError, digest } from '../../domain.js';
import { RequestReader } from '../requests/reader.js';

/** 续租窗口允许短暂网络抖动；一次分析最长三十分钟，最多恢复三次。 */
const LEASE_MS = 60_000;
const MAX_RUN_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;
/** 分片覆盖全部存档文字，不静默截断历史；最终结论有独立长度限制。 */
const PAGE_CHARS = 24_000;
const MAX_SUMMARY_CHARS = 12_000;
/** 公共视图不返回分析输入或领取凭据。 */
const VIEW = `revision,status,summary,error,model,requested_at AS "requestedAt",generated_at AS "generatedAt"`;

/** 持久队列与 CAS 回执隔离分析和浏览器执行，重复打开报告不会重复消费模型。 */
export class RequestAnalyses {
  constructor(
    /** 持久化队列与领取租约。 */
    private readonly db: Database,
    /** 冻结当前报告，所有输入保持请求成员归属。 */
    private readonly reader: RequestReader,
  ) {}

  /** 查询本身不触发生成；页面可按需提交幂等生成请求。 */
  async get(id: string): Promise<RequestAnalysis | null> {
    await this.reader.get(id);
    const result = await this.db.query<RequestAnalysis>(
      `SELECT ${VIEW} FROM pr_request_analyses WHERE request_id=$1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  /** 只对结束的请求生成最终分析；显式重跑保留旧结论直到新结果可用。 */
  async enqueue(id: string, rerun: boolean) {
    const snapshot = await this.reader.get(id);
    if (snapshot.executionStatus !== 'FINISHED')
      throw new ApiError(
        409,
        'ANALYSIS_NOT_READY',
        '验证尚未结束，结束后会自动生成分析。',
      );
    await this.db.query(
      `INSERT INTO pr_request_analyses(request_id,revision,status,snapshot)
      VALUES($1,$2,'QUEUED',$3) ON CONFLICT(request_id) DO UPDATE SET
      revision=EXCLUDED.revision,status='QUEUED',snapshot=EXCLUDED.snapshot,error=NULL,
      requested_at=clock_timestamp(),attempts=0,token_hash=NULL,lease_until=NULL,started_at=NULL
      WHERE $4 AND pr_request_analyses.status IN ('SUCCEEDED','FAILED')`,
      [id, randomUUID(), JSON.stringify(snapshot), rerun],
    );
    return this.get(id);
  }

  /** 行锁避免多 worker 重复领取；失联有界恢复，超期明确失败而非永久转圈。 */
  async claim() {
    return this.db.transaction(async (client) => {
      await client.query(
        `UPDATE pr_request_analyses SET status='FAILED',error='分析超时或 Worker 多次中断，请重新分析。',token_hash=NULL
        WHERE status='RUNNING' AND (started_at < clock_timestamp()-($1 * interval '1 millisecond') OR (lease_until < clock_timestamp() AND attempts >= $2))`,
        [MAX_RUN_MS, MAX_ATTEMPTS],
      );
      const row = (
        await client.query<{
          request_id: string;
          snapshot: RequestResultV2;
        }>(`SELECT request_id,snapshot FROM pr_request_analyses
        WHERE status='QUEUED' OR (status='RUNNING' AND lease_until < clock_timestamp())
        ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1`)
      ).rows[0];
      if (!row) return null;
      const token = randomUUID();
      await client.query(
        `UPDATE pr_request_analyses SET status='RUNNING',token_hash=$2,
        lease_until=clock_timestamp()+($3 * interval '1 millisecond'),started_at=coalesce(started_at,clock_timestamp()),attempts=attempts+1 WHERE request_id=$1`,
        [row.request_id, digest(token), LEASE_MS],
      );
      return {
        requestId: row.request_id,
        caseCount: row.snapshot.cases.length,
        token,
      };
    });
  }

  /** 每次读写校验当前领取；旧 worker 不能续租或覆盖恢复后的结果。 */
  private async snapshot(id: string, token: string): Promise<RequestResultV2> {
    const row = (
      await this.db.query(
        `SELECT snapshot FROM pr_request_analyses WHERE request_id=$1 AND token_hash=$2 AND status='RUNNING'
      AND lease_until>clock_timestamp() AND started_at>clock_timestamp()-($3 * interval '1 millisecond')`,
        [id, digest(token), MAX_RUN_MS],
      )
    ).rows[0];
    if (!row)
      throw new ApiError(409, 'ANALYSIS_LEASE_LOST', '分析领取已失效。');
    return row.snapshot;
  }

  /** 心跳不延长总时限，重启或超时必须领取新的令牌。 */
  async heartbeat(id: string, token: string) {
    const result = await this.db.query(
      `UPDATE pr_request_analyses SET lease_until=clock_timestamp()+($3 * interval '1 millisecond')
      WHERE request_id=$1 AND token_hash=$2 AND status='RUNNING' AND lease_until>clock_timestamp()
      AND started_at>clock_timestamp()-($4 * interval '1 millisecond')`,
      [id, digest(token), LEASE_MS, MAX_RUN_MS],
    );
    if (!result.rowCount)
      throw new ApiError(409, 'ANALYSIS_LEASE_LOST', '分析领取已失效。');
    return { renewed: true };
  }

  /** 首条提供完整步骤与验收结果，后续按调用顺序提供实际观察和模型响应。 */
  async context(
    id: string,
    token: string,
    caseIndex: number,
    record: number,
    offset: number,
  ): Promise<AnalysisContextPage> {
    if (
      ![caseIndex, record, offset].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      throw new ApiError(400, 'INVALID_ANALYSIS_CURSOR', '分析记录游标无效。');
    const snapshot = await this.snapshot(id, token);
    const member = snapshot.cases[caseIndex];
    if (!member)
      throw new ApiError(400, 'INVALID_ANALYSIS_CASE', '分析 case 不存在。');
    const arm = requestCaseArm(member);
    let text: string;
    if (record === 0) {
      text = JSON.stringify({
        requestTitle: snapshot.title,
        overall: requestVerification(snapshot),
        case: { ...member, arms: arm ? [arm] : [] },
        limitation: arm?.archivedAt
          ? '原始观察已归档清理，只能基于保留的步骤和报告总结。'
          : '只依据已存档文字观察，未重新读取截图或运行浏览器。',
      });
    } else {
      // 只取实际输入与回复，不重复系统提示词、工具 schema 或供应商连接参数。
      const row = (
        await this.db.query(
          `SELECT jsonb_build_object('callIndex',m.call_index,'stepId',m.record->'stepId','purpose',m.record->'purpose',
        'input',CASE WHEN m.record->>'request' IS NULL THEN NULL ELSE
          coalesce((SELECT jsonb_agg(message) FROM jsonb_array_elements(coalesce((m.record->>'request')::jsonb->'messages','[]'::jsonb)) message WHERE message->>'role'<>'system'), '[]'::jsonb) END,
        'state', (m.record->>'request')::jsonb->'state', 'questions',(m.record->>'request')::jsonb->'questions',
        'response',m.record->'response','error',m.record->'error','archived',m.record->'archived')::text AS text
        FROM pr_model_calls m JOIN pr_executions e ON e.id=m.execution_id WHERE e.task_id=$1 ORDER BY m.call_index LIMIT 1 OFFSET $2`,
          [arm?.taskId ?? '', record - 1],
        )
      ).rows[0];
      if (!row)
        return {
          text:
            record === 1
              ? '没有可用的模型调用观察记录；只能依据已保存的报告和步骤归纳，不能推断未记录的过程。'
              : '',
          next: null,
        };
      text = row.text;
    }
    return {
      text: text.slice(offset, offset + PAGE_CHARS),
      next:
        offset + PAGE_CHARS < text.length
          ? { record, offset: offset + PAGE_CHARS }
          : { record: record + 1, offset: 0 },
    };
  }

  /** 完成回执原子校验租约；供应商错误只接受安全统一说明。 */
  async finish(id: string, token: string, body: unknown) {
    const value = body as {
      summary?: unknown;
      model?: unknown;
      failed?: unknown;
    } | null;
    if (
      !value ||
      typeof value !== 'object' ||
      (value.failed !== true &&
        (typeof value.summary !== 'string' ||
          !value.summary.trim() ||
          value.summary.length > MAX_SUMMARY_CHARS ||
          typeof value.model !== 'string' ||
          !value.model ||
          value.model.length > 200))
    )
      throw new ApiError(400, 'INVALID_ANALYSIS_RESULT', '分析结果格式无效。');
    const failed = value.failed === true;
    const result = await this.db.query(
      `UPDATE pr_request_analyses SET status=$3,
      summary=CASE WHEN $3='SUCCEEDED' THEN $4 ELSE summary END,
      model=CASE WHEN $3='SUCCEEDED' THEN $5 ELSE model END,
      generated_at=CASE WHEN $3='SUCCEEDED' THEN clock_timestamp() ELSE generated_at END,
      error=CASE WHEN $3='FAILED' THEN '分析生成失败，请重新分析。' ELSE NULL END
      WHERE request_id=$1 AND token_hash=$2 AND status='RUNNING' AND lease_until>clock_timestamp()
      AND started_at>clock_timestamp()-($6 * interval '1 millisecond')`,
      [
        id,
        digest(token),
        failed ? 'FAILED' : 'SUCCEEDED',
        failed ? null : value.summary,
        failed ? null : value.model,
        MAX_RUN_MS,
      ],
    );
    if (!result.rowCount)
      throw new ApiError(409, 'ANALYSIS_LEASE_LOST', '分析领取已失效。');
    return { recorded: true };
  }
}
