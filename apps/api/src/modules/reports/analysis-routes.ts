import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { ApiError } from '../../domain.js';
import type { RequestAnalyses } from './request-analysis.js';

/** 公开读写使用管理员认证，worker 仅能领取分析并凭独立令牌访问其上下文。 */
export function analysisRoutes(
  app: FastifyInstance,
  analyses: RequestAnalyses,
  admin: preHandlerHookHandler,
  worker: preHandlerHookHandler,
) {
  app.get<{ Params: { id: string } }>(
    '/v2/requests/:id/analysis',
    { preHandler: admin },
    (request) => analyses.get(request.params.id),
  );
  app.post<{ Params: { id: string } }>(
    '/v2/requests/:id/analysis',
    { preHandler: admin },
    async (request, reply) => {
      const body = request.body as { rerun?: unknown } | null;
      if (
        !body ||
        typeof body !== 'object' ||
        Object.keys(body).some((key) => key !== 'rerun') ||
        (body.rerun !== undefined && typeof body.rerun !== 'boolean')
      )
        throw new ApiError(
          400,
          'INVALID_ANALYSIS_REQUEST',
          '分析请求格式无效。',
        );
      return reply
        .code(202)
        .send(await analyses.enqueue(request.params.id, body.rerun === true));
    },
  );
  app.post('/v1/worker/analyses/claim', { preHandler: worker }, () =>
    analyses.claim(),
  );
  app.get<{
    Params: { id: string };
    Querystring: { caseIndex: string; record: string; offset: string };
  }>('/v1/analyses/:id/context', (request) =>
    analyses.context(
      request.params.id,
      token(request.headers.authorization),
      Number(request.query.caseIndex),
      Number(request.query.record),
      Number(request.query.offset),
    ),
  );
  app.post<{ Params: { id: string } }>(
    '/v1/analyses/:id/heartbeat',
    (request) =>
      analyses.heartbeat(
        request.params.id,
        token(request.headers.authorization),
      ),
  );
  app.post<{ Params: { id: string; callId: string } }>(
    '/v1/analyses/:id/model-calls/:callId',
    (request) =>
      analyses.recordCall(
        request.params.id,
        request.params.callId,
        token(request.headers.authorization),
        request.body,
      ),
  );
  app.post<{ Params: { id: string } }>('/v1/analyses/:id/complete', (request) =>
    analyses.finish(
      request.params.id,
      token(request.headers.authorization),
      request.body,
    ),
  );
}

/** 缺少领取凭据时在访问数据库前拒绝。 */
function token(authorization: string | undefined): string {
  if (!authorization?.startsWith('Bearer ') || authorization.length < 20)
    throw new ApiError(401, 'UNAUTHORIZED', '缺少分析凭据。');
  return authorization.slice(7);
}
