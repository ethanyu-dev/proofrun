import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import type { ApiConfig } from './config.js';

/** 主备竞争间隔；数据库锁是唯一调度所有权，HTTP 就绪探针不能授予所有权。 */
const ELECTION_MS = 1000;
/** 防止负载均衡未及时摘除备用实例时堆积客户端请求。 */
const RETRY_SECONDS = '1';

/** 每个副本保持固定入口；只有取得数据库独占锁的副本运行完整控制面。 */
export class HaApi {
  /** 负载均衡访问的公开 HTTP/WS 入口。 */
  readonly server: Server;
  /** 当前进程拥有的内部控制面，失去所有权后立即停止转发。 */
  private leader: { app: FastifyInstance; port: number } | undefined;
  /** 所有升级通道必须在降级和退出时断开，让节点重新连接活动实例。 */
  private readonly tunnels = new Set<Socket>();
  private timer?: ReturnType<typeof setTimeout>;
  private electing: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly config: ApiConfig) {
    this.server = createServer((incoming, outgoing) => {
      const leader = this.leader;
      if (!leader) {
        const live = incoming.url === '/health/live';
        outgoing.writeHead(live ? 200 : 503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Retry-After': RETRY_SECONDS,
        });
        outgoing.end(
          JSON.stringify({
            service: 'proofrun-api',
            status: 'standby',
            ready: false,
          }),
        );
        incoming.resume();
        return;
      }
      // 保留原始 Host/Origin 供控制面验证同源；不缓冲证据上传和下载。
      const upstream = httpRequest(
        {
          host: '127.0.0.1',
          port: leader.port,
          path: incoming.url,
          method: incoming.method,
          headers: incoming.headers,
        },
        (response) => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
          response.on('error', () => outgoing.destroy());
        },
      );
      upstream.on('error', () => {
        if (!outgoing.headersSent)
          outgoing.writeHead(503, { 'Retry-After': RETRY_SECONDS });
        outgoing.end();
      });
      incoming.on('aborted', () => upstream.destroy());
      outgoing.on('close', () => upstream.destroy());
      incoming.pipe(upstream);
    });
    this.server.on('upgrade', (request, socket, head) => {
      const leader = this.leader;
      if (!leader) {
        socket.end(
          'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 1\r\n\r\n',
        );
        return;
      }
      const upstream = connect(leader.port, '127.0.0.1');
      const client = socket as Socket;
      this.tunnels.add(client);
      const close = () => {
        this.tunnels.delete(client);
        client.destroy();
        upstream.destroy();
      };
      client.on('error', close);
      upstream.on('error', close);
      client.on('close', close);
      upstream.on('close', close);
      upstream.on('connect', () => {
        if (this.leader !== leader) {
          close();
          return;
        }
        const headers = request.rawHeaders;
        let raw = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
        for (let i = 0; i < headers.length; i += 2)
          raw += `${headers[i]}: ${headers[i + 1]}\r\n`;
        upstream.write(`${raw}\r\n`);
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
    });
  }

  /** 公开入口先上线提供存活探针；备用实例一直保持 ready=503。 */
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    this.schedule(0);
  }

  private schedule(delay = ELECTION_MS) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.electing = this.elect().finally(() => {
        this.electing = undefined;
        this.schedule();
      });
    }, delay);
  }

  /** buildApp 在建表、接入和调度之前取得锁；竞争失败不启动业务组件。 */
  private async elect(): Promise<void> {
    if (this.leader || this.stopped) return;
    let app: FastifyInstance | undefined;
    try {
      app = await buildApp(this.config, { logger: false });
      const owned = app;
      // 锁连接异常会触发 app.close；先撤销外部流量，再让控制面清理并释放锁。
      app.addHook('preClose', async () => {
        if (this.leader?.app === owned) this.leader = undefined;
        for (const socket of this.tunnels) socket.destroy();
      });
      if (this.stopped) {
        await app.close();
        return;
      }
      await app.listen({ host: '127.0.0.1', port: 0 });
      if (this.stopped) {
        await app.close();
        return;
      }
      const address = app.server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing internal listener');
      this.leader = { app, port: address.port };
    } catch (error) {
      await app?.close().catch(() => {});
      // 竞争失败是正常备用状态；仅记录分类，不能泄露数据库 URL 或凭据。
      if (!(
        error instanceof Error && error.message.includes('Another ProofRun API')
      ))
        console.error(JSON.stringify({ event: 'ha.election_failed' }));
    }
  }

  /** 主动关停撤销就绪状态、关闭所有 WS，最后释放控制面的数据库锁。 */
  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    const leader = this.leader;
    this.leader = undefined;
    for (const socket of this.tunnels) socket.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.electing;
    await leader?.app.close();
  }
}
