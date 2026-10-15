import Fastify from 'fastify';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  validateNotificationEvent,
  type NotificationView,
} from '@proofrun/contracts';
import { canonical, requireToken } from '../src/domain.js';

/** cc-connect 协议模拟器：收件箱使用真实 PostgreSQL，卡片只保存在内存，不发送飞书消息。 */
export class MockNotifications {
  readonly app = Fastify({ logger: false });
  /** 故障注入只影响模拟服务；用于验证丢失确认后的同身份重试。 */
  dropNextAck = false;
  unavailable = false;
  deliveryStatus: 'delivered' | 'unknown' | 'failed' = 'delivered';
  /** 模拟同一群中按聚合更新卡片，旧序列不得覆盖新状态。 */
  readonly cards = new Map<string, NotificationView>();
  base = '';
  constructor(
    private readonly sql: pg.Pool,
    private readonly deliveryToken: string,
    private readonly viewToken: string,
    private readonly proofrun: () => string,
  ) {}

  /** 注册冻结绑定、持久入箱和回执查询三个约定端点。 */
  async start(port = 0) {
    await this.sql.query(
      'CREATE TABLE IF NOT EXISTS mock_notification_inbox(event_id text PRIMARY KEY,payload jsonb NOT NULL,receipt_id text NOT NULL,status text NOT NULL,hits integer NOT NULL DEFAULT 1)',
    );
    this.app.addHook('preHandler', async (request, reply) => {
      requireToken(request.headers.authorization, this.deliveryToken);
      if (this.unavailable)
        return reply.code(503).send({ error: '模拟服务离线' });
    });
    this.app.get<{ Params: { ref: string }; Querystring: { version: string } }>(
      '/integrations/v1/proofrun/bindings/:ref',
      async (request) => ({
        integrationId: 'mock-cc',
        bindingRef: request.params.ref,
        bindingVersion: Number(request.query.version),
        enabled: true,
        botReady: true,
      }),
    );
    this.app.post(
      '/integrations/v1/proofrun/events',
      async (request, reply) => {
        const payload = request.body;
        if (!validateNotificationEvent(payload))
          return reply.code(400).send({ error: '事件契约错误' });
        const stored = (
          await this.sql.query(
            `INSERT INTO mock_notification_inbox(event_id,payload,receipt_id,status) VALUES($1,$2,$3,'accepted') ON CONFLICT(event_id) DO UPDATE SET hits=mock_notification_inbox.hits+1 RETURNING *`,
            [payload.eventId, payload, randomUUID()],
          )
        ).rows[0]!;
        if (canonical(stored.payload) !== canonical(payload))
          return reply.code(409).send({ error: '事件身份冲突' });
        if (this.dropNextAck) {
          this.dropNextAck = false;
          reply.hijack();
          request.raw.socket.destroy();
          return;
        }
        return reply.code(stored.hits === 1 ? 202 : 200).send({
          eventId: stored.event_id,
          receiptId: stored.receipt_id,
          status: stored.status,
        });
      },
    );
    this.app.get<{ Params: { id: string } }>(
      '/integrations/v1/proofrun/deliveries/:id',
      async (request, reply) => {
        const row = (
          await this.sql.query(
            'SELECT * FROM mock_notification_inbox WHERE event_id=$1',
            [request.params.id],
          )
        ).rows[0];
        if (!row) return reply.code(404).send({ error: '未入箱' });
        const viewResponse = await fetch(
          `${this.proofrun()}/v1/integrations/notifications/${row.event_id}/view`,
          { headers: { authorization: `Bearer ${this.viewToken}` } },
        );
        if (!viewResponse.ok)
          return reply.code(503).send({ error: '回读失败' });
        const view = (await viewResponse.json()) as NotificationView;
        const current = this.cards.get(view.aggregate.id);
        const status =
          current && current.aggregate.sequence > view.aggregate.sequence
            ? 'superseded'
            : this.deliveryStatus;
        if (status === 'delivered') this.cards.set(view.aggregate.id, view);
        await this.sql.query(
          'UPDATE mock_notification_inbox SET status=$2 WHERE event_id=$1',
          [row.event_id, status],
        );
        return {
          eventId: row.event_id,
          receiptId: row.receipt_id,
          status,
          attempts: 1,
        };
      },
    );
    this.base = await this.app.listen({ port, host: '127.0.0.1' });
  }
}
