import type { FastifyInstance } from 'fastify';
import { validateRuntimeRequest } from '@proofrun/contracts';
import { ApiError, bearer } from '../../domain.js';
import type { ExecutionRuntime } from './service.js';

/** 根据已匹配的路由模板围住旧写入，避免原始 URL 编码影响门禁；管理员和心跳使用其他入口。 */
const LEGACY_WRITE = new Set([
  '/v1/executions/:id/steps',
  '/v1/executions/:id/commands',
  '/v1/executions/:id/complete',
  '/v1/executions/:id/intervene',
  '/v1/executions/:id/control',
  '/v1/executions/:id/model-calls/:callId',
]);
/** 内部运行时仅接受单次执行租约凭据。 */
export function registerExecutionRuntime(
  app: FastifyInstance,
  runtime: ExecutionRuntime,
) {
  app.addHook('preHandler', async (request) => {
    if (
      request.method !== 'POST' ||
      !LEGACY_WRITE.has(request.routeOptions.url ?? '')
    )
      return;
    await runtime.requireLegacy(
      (request.params as { id: string }).id,
      bearer(request.headers.authorization),
    );
  });
  app.post<{ Params: { id: string } }>(
    '/v1/executions/:id/runtime',
    async (request) => {
      if (
        !validateRuntimeRequest(request.body) ||
        request.body.type !== 'start'
      )
        throw new ApiError(
          400,
          'INVALID_RUNTIME_REQUEST',
          '运行时启动参数无效',
        );
      return runtime.start(
        request.params.id,
        bearer(request.headers.authorization),
        request.body.config,
      );
    },
  );
  app.get<{ Params: { id: string }; Querystring: { afterRevision?: string } }>(
    '/v1/executions/:id/runtime',
    async (request) => {
      if (
        Object.keys(request.query).some((k) => k !== 'afterRevision') ||
        !/^\d+$/.test(request.query.afterRevision ?? '0')
      )
        throw new ApiError(400, 'INVALID_QUERY', '运行时游标无效');
      const after = Number(request.query.afterRevision ?? 0);
      if (!Number.isSafeInteger(after))
        throw new ApiError(400, 'INVALID_QUERY', '运行时游标无效');
      return runtime.view(
        request.params.id,
        bearer(request.headers.authorization),
        after,
      );
    },
  );
  app.post<{ Params: { id: string; decisionId: string } }>(
    '/v1/executions/:id/runtime/decisions/:decisionId',
    async (request) => {
      if (
        !validateRuntimeRequest(request.body) ||
        request.body.type === 'start'
      )
        throw new ApiError(
          400,
          'INVALID_RUNTIME_REQUEST',
          '运行时决定参数无效',
        );
      return runtime.mutate(
        request.params.id,
        bearer(request.headers.authorization),
        request.params.decisionId,
        request.body,
      );
    },
  );
}
