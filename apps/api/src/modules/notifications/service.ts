import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../../db.js';
import type { ApiConfig } from '../../config.js';
import { digest } from '../../domain.js';
import { caseCard, type CaseEvent, type CaseView } from './card.js';
import { FeishuClient, FeishuError, type FeishuTransport } from './feishu.js';
import { readCase } from './source.js';
import {
  readRequest,
  REQUEST_RUN_PREFIX,
  type RequestView,
} from './request-source.js';
import { requestCard } from './request-card.js';

/** 旧独立任务与 v2 请求共用可靠投递队列，但保留各自展示范围。 */
type NotificationView = CaseView | RequestView;

/** 每轮一个请求或独立 Case、最多一次发送及三次旧消息更新；外部请求不进入业务调度 tick。 */
const SCAN_MS = 1000;
const UPDATES_PER_TICK = 3;
/** 单个操作最多五次；每个新的视图版本重置更新重试次数。 */
const MAX_ATTEMPTS = 5;
const RETRY_MS = 10_000;
/** 飞书发送去重窗口为一小时，提前五分钟停止结果未知的重发。 */
const SEND_WINDOW_MS = 55 * 60_000;
/** 更新接口只支持发送后十四天内的消息。 */
const EDIT_WINDOW_MS = 14 * 86_400_000;
/** 每次只发现有限轮次，旧轮次用持久游标轮转，避免饥饿。 */
const DISCOVERY_LIMIT = 64;

/** 消息发送与更新分别记录进度，单条失败不阻挡其他旧卡片同步。 */
interface Message {
  /** 同时作为飞书发送的稳定 uuid，重试不创建新身份。 */
  id: string;
  /** 原始事件元数据，发送和更新时均不改写。 */
  event: CaseEvent;
  /** 首次尝试前冻结，不含任何令牌。 */
  initial_view: NotificationView | null;
  /** 飞书回执中的消息身份；为空时尚未确认送达。 */
  message_id: string | null;
  /** 本地确认送达时间，用于更新窗口的保守判断。 */
  sent_at: Date | null;
  /** 首次尝试时间跨重启保留，避免超过飞书去重窗口再次发送。 */
  first_attempt_at: Date | null;
  /** 发送重试次数及下次可尝试时间。 */
  send_attempts: number;
  send_next_at: Date;
  /** 飞书已确认的内容摘要，不保存含 HITL token 的完整卡片。 */
  applied_hash: string | null;
  /** 本轮待更新内容摘要，变化时重置退避。 */
  update_hash: string | null;
  /** 当前目标版本的更新次数及下次可尝试时间。 */
  update_attempts: number;
  update_next_at: Date;
  /** 飞书明确拒绝更新已撤回、删除或超期的消息。 */
  uneditable: boolean;
}

/** 从持久业务事实派生通知；消息投递失败不会改变任务状态或控制权。 */
export class CaseNotifications {
  /** 只有配置完整时才建立客户端及扫描器。 */
  private readonly transport: FeishuTransport | undefined;
  /** 固定目的地避免配置切换时操作旧应用或旧群的消息。 */
  private readonly destination: string | undefined;
  /** 初始化与扫描分别合并并发调用。 */
  private initialized: Promise<void> | undefined;
  private running: Promise<void> | undefined;
  /** 停机取消所有通知网络请求，释放数据库前等待收尾。 */
  private readonly stop = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: Database,
    private readonly config: ApiConfig,
    private readonly log: Pick<FastifyBaseLogger, 'warn' | 'error'>,
    transport?: FeishuTransport,
  ) {
    this.transport = config.feishu
      ? (transport ?? new FeishuClient(config.feishu))
      : undefined;
    this.destination = config.feishu
      ? digest(JSON.stringify([config.feishu.appId, config.feishu.chatId]))
      : undefined;
  }

  /** 服务就绪前登记通知起点；不向新群补发全部历史 Case。 */
  async start(): Promise<void> {
    if (!this.transport || this.timer || this.stop.signal.aborted) return;
    await this.initialize();
    if (this.stop.signal.aborted) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() =>
        this.log.error('飞书 Case 通知扫描失败，请检查控制面数据库'),
      );
    }, SCAN_MS);
    this.timer.unref();
  }

  /** 同一应用/群重启沿用原起点，允许补齐停机期间的事件。 */
  private initialize(): Promise<void> {
    if (!this.initialized)
      this.initialized = this.db
        .query(
          'INSERT INTO pr_feishu_destinations(id,app_id,chat_id) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
          [
            this.destination,
            this.config.feishu!.appId,
            this.config.feishu!.chatId,
          ],
        )
        .then(() => {})
        .catch((error) => {
          this.initialized = undefined;
          throw error;
        });
    return this.initialized;
  }

  /** 同一实例禁止重叠扫描；未配置或失去数据库所有权时不发送。 */
  tick(): Promise<void> {
    if (!this.transport || this.stop.signal.aborted || !this.db.healthy)
      return Promise.resolve();
    if (!this.running)
      this.running = this.scan().finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  /** 发现提交后逐轮处理；事件源没有高水位截断，迟提交事务和快速转换不会丢失。 */
  private async scan(): Promise<void> {
    await this.initialize();
    await this.db.query(
      `INSERT INTO pr_feishu_runs(destination_id,run_key)
       SELECT $1, $3||r.request_id||COALESCE(':'||rr.definition_hash,'') FROM pr_verification_requests r
       LEFT JOIN LATERAL (
         SELECT definition_hash,created_at FROM pr_request_reruns WHERE request_id=r.request_id
         ORDER BY created_at DESC,definition_hash DESC LIMIT 1
       ) rr ON true
       JOIN pr_feishu_destinations d ON d.id=$1
       WHERE COALESCE(rr.created_at,r.created_at)>=d.started_at
       AND NOT EXISTS(SELECT 1 FROM pr_feishu_runs n WHERE n.destination_id=$1 AND n.run_key=$3||r.request_id||COALESCE(':'||rr.definition_hash,''))
       ORDER BY COALESCE(rr.created_at,r.created_at),r.request_id LIMIT $2 ON CONFLICT DO NOTHING`,
      [this.destination, DISCOVERY_LIMIT, REQUEST_RUN_PREFIX],
    );
    await this.db.query(
      `INSERT INTO pr_feishu_runs(destination_id,run_key)
      SELECT $1,COALESCE(t.definition#>>'{comparison,id}',t.id)
      FROM pr_tasks t JOIN pr_feishu_destinations d ON d.id=$1
      WHERE t.created_at>=d.started_at AND COALESCE(t.definition->>'purpose','verification')<>'cleanup'
        AND NOT EXISTS(SELECT 1 FROM pr_request_runs a WHERE a.task_id=t.id)
        AND NOT EXISTS(SELECT 1 FROM pr_node_profiles p WHERE p.task_id=t.id)
        AND NOT EXISTS(SELECT 1 FROM pr_feishu_runs r WHERE r.destination_id=$1 AND r.run_key=COALESCE(t.definition#>>'{comparison,id}',t.id))
      ORDER BY t.created_at,t.id LIMIT $2 ON CONFLICT DO NOTHING`,
      [this.destination, DISCOVERY_LIMIT],
    );
    const run = (
      await this.db.query<{ run_key: string }>(
        'SELECT run_key FROM pr_feishu_runs WHERE destination_id=$1 AND settled_at IS NULL AND next_at<=clock_timestamp() ORDER BY next_at,run_key LIMIT 1',
        [this.destination],
      )
    ).rows[0];
    if (!run || this.stop.signal.aborted || !this.db.healthy) return;
    // 查询或单条故障也让出轮次，不能让一个坏 Case 饿死其他通知。
    await this.db.query(
      "UPDATE pr_feishu_runs SET next_at=clock_timestamp()+$3*interval '1 millisecond' WHERE destination_id=$1 AND run_key=$2",
      [this.destination, run.run_key, SCAN_MS],
    );
    // requestId 不允许冒号；后缀为本轮重跑的幂等摘要，首次提交沿用原轮次键。
    const [requestId, rerunHash] = run.run_key
      .slice(REQUEST_RUN_PREFIX.length)
      .split(':');
    const snapshot = run.run_key.startsWith(REQUEST_RUN_PREFIX)
      ? await readRequest(this.db, requestId!, rerunHash ?? null)
      : await readCase(this.db, run.run_key);
    // 请求已切换到新轮次时停止旧队列，不能将新状态写入旧轮次或补发旧事件。
    if (!snapshot) {
      await this.db.query(
        'UPDATE pr_feishu_runs SET settled_at=clock_timestamp() WHERE destination_id=$1 AND run_key=$2',
        [this.destination, run.run_key],
      );
      return;
    }
    const { view, events } = snapshot;
    await this.db.transaction(async (client) => {
      for (const event of events)
        await client.query(
          `INSERT INTO pr_feishu_messages(id,destination_id,run_key,event_key,event,occurred_at)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(destination_id,run_key,event_key) DO NOTHING`,
          [
            randomUUID(),
            this.destination,
            run.run_key,
            event.key,
            event,
            event.at,
          ],
        );
    });
    const messages = (
      await this.db.query<Message>(
        `SELECT * FROM pr_feishu_messages WHERE destination_id=$1 AND run_key=$2
       ORDER BY CASE event->>'kind' WHEN 'SUBMITTED' THEN 0 WHEN 'COMPLETED' THEN 2 ELSE 1 END,occurred_at,
         CASE WHEN event_key LIKE 'control-%' THEN substring(event_key FROM 9)::bigint ELSE 0 END`,
        [this.destination, run.run_key],
      )
    ).rows;
    // 提交卡片优先于复用任务中更早发生的 HITL；失败达到上限后不永久阻挡后续通知。
    const pending = messages.find(
      (message) => !message.message_id && message.send_attempts < MAX_ATTEMPTS,
    );
    if (pending && pending.send_next_at.getTime() <= Date.now())
      await this.send(pending, view);
    let updates = 0;
    for (const message of messages) {
      if (
        !message.message_id ||
        message.uneditable ||
        this.stop.signal.aborted ||
        !this.db.healthy
      )
        continue;
      const card = this.card(message.event, view);
      const hash = digest(JSON.stringify(card));
      if (message.applied_hash === hash) continue;
      if (message.update_hash !== hash) {
        message.update_hash = hash;
        message.update_attempts = 0;
        message.update_next_at = new Date(0);
        await this.db.query(
          'UPDATE pr_feishu_messages SET update_hash=$2,update_attempts=0,update_next_at=clock_timestamp() WHERE id=$1',
          [message.id, hash],
        );
      }
      if (
        message.update_attempts >= MAX_ATTEMPTS ||
        message.update_next_at.getTime() > Date.now() ||
        updates >= UPDATES_PER_TICK
      )
        continue;
      updates++;
      await this.update(message, card, hash);
    }
    const done =
      view.terminal &&
      messages.every((message) =>
        message.message_id
          ? message.uneditable ||
            message.applied_hash ===
              digest(JSON.stringify(this.card(message.event, view))) ||
            message.update_attempts >= MAX_ATTEMPTS
          : message.send_attempts >= MAX_ATTEMPTS,
      );
    if (done)
      await this.db.query(
        'UPDATE pr_feishu_runs SET settled_at=clock_timestamp() WHERE destination_id=$1 AND run_key=$2',
        [this.destination, run.run_key],
      );
  }

  /** 生成链接只发生在内存，不把 token 写入通知进度表。 */
  private card(event: CaseEvent, view: NotificationView) {
    if ('requestId' in view)
      return requestCard(
        event,
        view,
        this.config.consoleUrl ?? this.config.publicUrl,
        this.config.adminToken,
      );
    return caseCard(
      event,
      view,
      this.config.consoleUrl ?? this.config.publicUrl,
      this.config.adminToken,
    );
  }

  /** 冻结首次请求内容及 uuid；一小时去重窗口外不猜测首次请求是否送达。 */
  private async send(message: Message, view: NotificationView): Promise<void> {
    if (this.stop.signal.aborted || !this.db.healthy) return;
    if (
      message.first_attempt_at &&
      Date.now() - message.first_attempt_at.getTime() >= SEND_WINDOW_MS
    ) {
      message.send_attempts = MAX_ATTEMPTS;
      await this.db.query(
        'UPDATE pr_feishu_messages SET send_attempts=$2 WHERE id=$1',
        [message.id, MAX_ATTEMPTS],
      );
      this.log.warn(
        { notificationId: message.id },
        '飞书发送已超过去重窗口，停止未知结果重发',
      );
      return;
    }
    message.initial_view ??= view;
    message.first_attempt_at ??= new Date();
    message.send_attempts++;
    await this.db.query(
      `UPDATE pr_feishu_messages SET initial_view=$2,first_attempt_at=COALESCE(first_attempt_at,clock_timestamp()),
      send_attempts=$3,send_next_at=clock_timestamp()+$4*interval '1 millisecond' WHERE id=$1`,
      [
        message.id,
        message.initial_view,
        message.send_attempts,
        RETRY_MS * 2 ** (message.send_attempts - 1),
      ],
    );
    const card = this.card(message.event, message.initial_view);
    let id: string;
    try {
      id = await this.transport!.send(card, message.id, this.stop.signal);
    } catch (error) {
      this.failure(message, '发送', error, message.send_attempts);
      return;
    }
    // 写库失败时仍使用原 uuid 重试，不另发新消息；下次同步会补齐最新状态。
    const hash = digest(JSON.stringify(card));
    await this.db.query(
      'UPDATE pr_feishu_messages SET message_id=$2,sent_at=clock_timestamp(),applied_hash=$3 WHERE id=$1',
      [message.id, id, hash],
    );
    message.message_id = id;
    message.sent_at = new Date();
    message.applied_hash = hash;
  }

  /** 每张旧卡片独立重试，已完成的更新不会因其他卡片失败而重复执行。 */
  private async update(
    message: Message,
    card: object,
    hash: string,
  ): Promise<void> {
    if (
      Date.now() - (message.first_attempt_at ?? message.sent_at!).getTime() >=
      EDIT_WINDOW_MS
    ) {
      message.uneditable = true;
      await this.db.query(
        'UPDATE pr_feishu_messages SET uneditable=true WHERE id=$1',
        [message.id],
      );
      this.log.warn(
        { notificationId: message.id },
        '飞书卡片已超过十四天更新窗口',
      );
      return;
    }
    message.update_attempts++;
    await this.db.query(
      "UPDATE pr_feishu_messages SET update_attempts=$2,update_next_at=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1",
      [
        message.id,
        message.update_attempts,
        RETRY_MS * 2 ** (message.update_attempts - 1),
      ],
    );
    try {
      await this.transport!.update(message.message_id!, card, this.stop.signal);
    } catch (error) {
      if (error instanceof FeishuError && error.uneditable) {
        message.uneditable = true;
        await this.db.query(
          'UPDATE pr_feishu_messages SET uneditable=true WHERE id=$1',
          [message.id],
        );
      }
      this.failure(message, '更新', error, message.update_attempts);
      return;
    }
    await this.db.query(
      'UPDATE pr_feishu_messages SET applied_hash=$2 WHERE id=$1',
      [message.id, hash],
    );
    message.applied_hash = hash;
  }

  /** 日志只含内部通知身份和数值错误码，不记录外部正文或卡片链接。 */
  private failure(
    message: Message,
    operation: string,
    error: unknown,
    attempt: number,
  ): void {
    if (this.stop.signal.aborted) return;
    this.log.warn(
      {
        notificationId: message.id,
        attempt,
        ...(error instanceof FeishuError
          ? { code: error.code, status: error.status }
          : {}),
      },
      `飞书卡片${operation}失败${attempt >= MAX_ATTEMPTS || message.uneditable ? '，已停止重试' : '，将退避重试'}`,
    );
  }

  /** 必须先取消外部请求，再释放数据库连接。 */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.stop.abort();
    await this.initialized?.catch(() => {});
    await this.running?.catch(() => {});
  }
}
