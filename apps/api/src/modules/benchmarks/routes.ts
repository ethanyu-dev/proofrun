import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { bearer } from '../../domain.js';
import type { Benchmarks } from './service.js';

/** 管理员才能发起和读取运行；合成页面只暴露本次随机任务下的固定测试资料。 */
export function registerBenchmarks(
  app: FastifyInstance,
  service: Benchmarks,
  admin: preHandlerHookHandler,
) {
  app.get('/v1/admin/benchmarks/status', { preHandler: admin }, () =>
    service.status(),
  );
  app.get('/v1/admin/benchmarks/versions', { preHandler: admin }, () =>
    service.versions(),
  );
  app.get<{ Querystring: { version?: string; after?: string } }>(
    '/v1/admin/benchmarks',
    { preHandler: admin },
    (request) => service.list(request.query.version, request.query.after),
  );
  app.post(
    '/v1/admin/benchmarks',
    { preHandler: admin },
    async (request, reply) =>
      reply.code(202).send(await service.create(request.body)),
  );
  app.get<{ Params: { id: string } }>(
    '/v1/admin/benchmarks/:id',
    { preHandler: admin },
    (request) => service.detail(request.params.id),
  );
  app.post<{ Params: { id: string } }>(
    '/v1/executions/:id/benchmark-build',
    (request) =>
      service.agent(
        request.params.id,
        bearer(request.headers.authorization),
        request.body,
      ),
  );
  app.get<{ Params: { id: string } }>(
    '/v1/benchmark-fixtures/:id',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      return reply
        .type('text/html; charset=utf-8')
        .send(await service.fixture(request.params.id));
    },
  );
  app.post<{ Params: { id: string } }>(
    '/v1/benchmark-fixtures/:id/save',
    { bodyLimit: 4096 },
    (request) => service.fixture(request.params.id, request.body),
  );
}
