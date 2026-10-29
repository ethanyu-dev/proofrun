import type { Database } from '../../db.js';
import type { CaseEvent, CaseView } from './card.js';
import { readCaseSnapshot } from './source.js';

/** 请求通知使用独立命名空间，不能与合法 task 身份冲突。 */
export const REQUEST_RUN_PREFIX = 'request:';

/** 请求快照只包含通知事实；不保存报告正文或派生人工处理令牌。 */
export interface RequestView extends CaseView {
  /** v2 请求的稳定身份，用于 Console 导航。 */
  requestId: string;
  /** 首次提交时冻结的完整成员顺序，单例完成不能使请求提前结束。 */
  cases: CaseView[];
}

/** 请求元数据、全部成员及控制事件在同一快照读取，包含复用的旧任务。 */
export async function readRequest(
  db: Database,
  requestId: string,
  // 重跑摘要确定通知轮次；旧轮次不允许读取替换后的任务状态。
  rerunHash: string | null = null,
): Promise<{
  view: RequestView;
  events: CaseEvent[];
} | null> {
  return db.transaction(async (client) => {
    await client.query(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    const request = (
      await client.query<{
        title: string;
        created_at: Date;
        rerun_hash: string | null;
      }>(
        `SELECT r.title,COALESCE(rr.created_at,r.created_at) AS created_at,rr.definition_hash AS rerun_hash
         FROM pr_verification_requests r
         LEFT JOIN LATERAL (
           SELECT definition_hash,created_at FROM pr_request_reruns WHERE request_id=r.request_id
           ORDER BY created_at DESC,definition_hash DESC LIMIT 1
         ) rr ON true WHERE r.request_id=$1`,
        [requestId],
      )
    ).rows[0];
    if (!request) throw new Error('通知对应的请求不存在');
    if (request.rerun_hash !== rerunHash) return null;
    const members = (
      await client.query<{ case_id: string; task_ids: string[] }>(
        `SELECT c.case_id,array_agg(a.task_id ORDER BY a.task_id) AS task_ids
       FROM pr_verification_request_cases c JOIN pr_request_runs a USING(request_id,case_id)
       WHERE c.request_id=$1 GROUP BY c.case_id,c.position ORDER BY c.position`,
        [requestId],
      )
    ).rows;
    if (!members.length) throw new Error('通知对应的请求没有成员');
    const cases: CaseView[] = [];
    const events: CaseEvent[] = [
      {
        key: 'submitted',
        kind: 'SUBMITTED',
        at: request.created_at.toISOString(),
        taskId: null,
        executionId: null,
        revision: null,
        reason: null,
      },
    ];
    const finishedAt: string[] = [];
    for (const member of members) {
      const result = await readCaseSnapshot(
        client,
        member.case_id,
        member.task_ids,
        request.created_at,
      );
      cases.push(result.view);
      for (const event of result.events) {
        if (event.kind === 'HITL')
          events.push({ ...event, key: `hitl:${member.case_id}` });
        if (event.kind === 'COMPLETED') finishedAt.push(event.at);
      }
    }
    const terminal = cases.every((item) => item.terminal);
    const state = terminal
      ? cases.every((item) => item.state === 'COMPLETED')
        ? 'COMPLETED'
        : 'ENDED'
      : cases.some((item) => item.state === 'WAITING_HUMAN')
        ? 'WAITING_HUMAN'
        : cases.every((item) => item.state === 'QUEUED')
          ? 'QUEUED'
          : 'RUNNING';
    if (terminal)
      events.push({
        key: 'completed',
        kind: 'COMPLETED',
        at: new Date(
          Math.max(request.created_at.getTime(), ...finishedAt.map(Date.parse)),
        ).toISOString(),
        taskId: null,
        executionId: null,
        revision: null,
        reason: null,
      });
    return {
      view: {
        requestId,
        caseId: requestId,
        objective: request.title,
        state,
        terminal,
        cases,
        arms: cases.flatMap((item) => item.arms),
        endedRequests: cases.flatMap((item) => item.endedRequests),
      },
      events,
    };
  });
}
