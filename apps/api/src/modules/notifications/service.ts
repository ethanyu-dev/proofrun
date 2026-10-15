import {
  validateNotificationReceipt,
  validateNotificationView,
  type NotificationEvent,
  type NotificationView,
} from '@proofrun/contracts';
import type { Database } from '../../db.js';
import { ApiError, requireToken } from '../../domain.js';
import type { CaseV2Service } from '../cases/v2.js';
import type { HitlService } from '../hitl/service.js';
import type { ExecutionControl } from '../scheduling/control.js';
import type { IntegrationConfig } from '../integrations/config.js';
import { remote, RemoteError } from '../integrations/remote.js';

/** 后台扫描有独立生命周期，网络等待不占用控制面调度周期。 */
const SCAN_MS = 250;
/** 有界并发与退避，避免故障通知服务耗尽连接池或请求配额。 */
const BATCH_SIZE = 4;
/** 首次重试与回执轮询的基础间隔。 */
const RETRY_BASE_MS = 2000;
/** 基础退避上限，Retry-After 可要求更长等待。 */
const RETRY_MAX_MS = 60_000;
/** 不确定投递最多自动跟进一天，届时明确记录 unknown。 */
const RETRY_BUDGET_MS = 24 * 60 * 60_000;
/** 所有状态来自持久队列；进程内只保留关闭信号与一个扫描承诺。 */
export class NotificationService {
  /** 关闭时同时中止所有在途网络请求。 */
  private readonly abort = new AbortController();
  /** 扫描器不维持进程存活，由 API 生命周期管理。 */
  private timer: ReturnType<typeof setInterval> | undefined;
  /** 同一实例不重叠扫描，结合数据库单实例锁避免重复领取。 */
  private ticking: Promise<void> | undefined;
  constructor(
    private readonly db: Database,
    private readonly config: IntegrationConfig,
    private readonly cases: CaseV2Service,
    private readonly hitl: HitlService,
    private readonly control: ExecutionControl,
  ) {}

  /** 事件归属服务验证通过后才回读；旧事件始终得到聚合的最新状态。 */
  async view(
    eventId: string,
    authorization: string | undefined,
  ): Promise<NotificationView> {
    const connection = this.config.connections.find((item) => {
      try {
        requireToken(authorization, item.viewToken);
        return true;
      } catch {
        return false;
      }
    });
    if (!connection)
      throw new ApiError(401, 'UNAUTHORIZED', 'Invalid view credential');
    const row = (
      await this.db.query(
        `SELECT a.*,o.payload FROM pr_notification_outbox o JOIN pr_notification_aggregates a ON a.id=o.aggregate_id WHERE o.event_id=$1 AND o.payload->>'integrationId'=$2`,
        [eventId, connection.id],
      )
    ).rows[0];
    if (!row)
      throw new ApiError(404, 'NOTIFICATION_MISSING', 'Notification not found');
    const current =
      row.kind === 'hitl' && ['REQUESTED', 'HUMAN'].includes(row.snapshot.state)
        ? await this.hitl.readCurrent(row.snapshot.grantId)
        : { intervention: null };
    const view: NotificationView = {
      schemaVersion: 'proofrun.notification-view.v1',
      eventId,
      caseId: row.case_id,
      aggregate: { kind: row.kind, id: row.id, sequence: row.sequence },
      state: row.snapshot.state,
      title: row.snapshot.title ?? '测试已结束',
      items: row.snapshot.items ?? [],
      reason: row.snapshot.reason ?? null,
      action: current.intervention
        ? {
            type: 'open_url',
            url: current.intervention.url,
            expiresAt: current.intervention.expiresAt,
          }
        : null,
      ...(row.kind === 'case'
        ? { result: await this.cases.get(row.case_id) }
        : {}),
    };
    if (!validateNotificationView(view))
      throw new ApiError(
        500,
        'INVALID_NOTIFICATION_VIEW',
        '通知投影不符合契约',
      );
    return view;
  }

  /** 在就绪后启动，重复调用不会增加后台扫描器。 */
  start(onError: () => void): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.ticking || this.abort.signal.aborted) return;
      this.ticking = this.tick()
        .catch(onError)
        .finally(() => {
          this.ticking = undefined;
        });
    }, SCAN_MS);
    this.timer.unref();
  }
  /** 先停止网络与扫描，再由应用释放数据库所有权。 */
  async close(): Promise<void> {
    clearInterval(this.timer);
    this.abort.abort();
    await this.ticking;
  }
  /** 到期链接只在维护路径轮换；回读与模型查询完全不改变人工授权。 */
  private async tick(): Promise<void> {
    if (!this.db.healthy) return;
    const expired = (
      await this.db.query(
        `SELECT i.execution_id FROM pr_interventions i JOIN pr_executions e ON e.id=i.execution_id JOIN pr_integration_cases b ON e.task_id=ANY(b.task_ids) WHERE i.completed_at IS NULL AND i.expires_at<=clock_timestamp() AND i.revision=e.control_revision AND e.state='RUNNING' AND e.control_mode IN ('REQUESTED','HUMAN') AND e.lease_expires_at>clock_timestamp() AND (e.human_deadline_at IS NULL OR e.human_deadline_at>clock_timestamp()) LIMIT $1`,
        [BATCH_SIZE],
      )
    ).rows;
    for (const row of expired)
      await this.control.currentInterventionId(row.execution_id);
    const due = (
      await this.db.query(
        `SELECT * FROM pr_notification_outbox WHERE status IN ('pending','accepted','retrying') AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,created_at LIMIT $1`,
        [BATCH_SIZE],
      )
    ).rows;
    await Promise.all(due.map((row) => this.deliver(row)));
  }
  /** 202 只是入箱回执；只有查询到 delivered 才表明投递服务报告发送成功。 */
  private async deliver(row: any): Promise<void> {
    const payload = row.payload as NotificationEvent;
    const connection = this.config.connections.find(
      (item) => item.id === payload.integrationId,
    );
    if (!connection) {
      await this.db.query(
        "UPDATE pr_notification_outbox SET status='failed',last_error='INTEGRATION_NOT_CONFIGURED' WHERE event_id=$1",
        [row.event_id],
      );
      return;
    }
    const remaining = RETRY_BUDGET_MS - (Date.now() - row.created_at.getTime());
    if (remaining <= 0) {
      await this.db.query(
        "UPDATE pr_notification_outbox SET status='unknown',last_error='DELIVERY_DEADLINE_EXCEEDED' WHERE event_id=$1",
        [row.event_id],
      );
      return;
    }
    try {
      const receipt = await remote(
        connection,
        row.receipt
          ? `/integrations/v1/proofrun/deliveries/${encodeURIComponent(row.event_id)}`
          : '/integrations/v1/proofrun/events',
        row.receipt ? undefined : payload,
        this.abort.signal,
      );
      if (
        !validateNotificationReceipt(receipt) ||
        receipt.eventId !== row.event_id ||
        (row.receipt && receipt.receiptId !== row.receipt.receiptId)
      )
        throw new Error('Invalid notification receipt');
      // 不持久化远端自由文本错误，避免远端将刚回读的敏感链接写回本地审计记录。
      const safeReceipt = {
        eventId: receipt.eventId,
        receiptId: receipt.receiptId,
        status: receipt.status,
        ...(receipt.attempts !== undefined
          ? { attempts: receipt.attempts }
          : {}),
        ...(receipt.nextAttemptAt
          ? { nextAttemptAt: receipt.nextAttemptAt }
          : {}),
      };
      await this.db.query(
        `UPDATE pr_notification_outbox SET status=$2,receipt=$3,attempts=attempts+1,last_error=NULL,next_attempt_at=clock_timestamp()+$4*interval '1 millisecond' WHERE event_id=$1`,
        [
          row.event_id,
          receipt.status,
          safeReceipt,
          Math.min(
            remaining,
            Math.max(
              RETRY_BASE_MS,
              receipt.nextAttemptAt
                ? Date.parse(receipt.nextAttemptAt) - Date.now()
                : 0,
            ),
          ),
        ],
      );
    } catch (error) {
      if (this.abort.signal.aborted) return;
      const permanent =
        error instanceof RemoteError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status);
      const delay = Math.max(
        Math.min(
          RETRY_MAX_MS,
          RETRY_BASE_MS * 2 ** Math.min(row.attempts, 10),
        ) *
          (1 + Math.random() * 0.2),
        error instanceof RemoteError ? error.retryAfterMs : 0,
      );
      await this.db.query(
        `UPDATE pr_notification_outbox SET status=$2,attempts=attempts+1,last_error=$3,next_attempt_at=clock_timestamp()+$4*interval '1 millisecond' WHERE event_id=$1`,
        [
          row.event_id,
          permanent ? 'failed' : 'retrying',
          error instanceof RemoteError
            ? `HTTP_${error.status}`
            : 'TRANSPORT_OR_RECEIPT_ERROR',
          Math.min(remaining, delay),
        ],
      );
    }
  }
}
