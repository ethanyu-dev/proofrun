import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  validateExternalExecutionRequest,
  externalExecutionRequestSchema,
  agentDecisionSchema,
  externalExecutionResultSchema,
  type ExternalExecutionRequest,
} from '@proofrun/contracts';
import { ApiError } from '../../domain.js';
import {
  authenticatePublic,
  type PublicCredential,
} from '../public-execution/auth.js';
import type { ExternalExecution } from './service.js';

/** 所有别名仍使用相同严格输入，不允许路径步骤身份被正文覆盖。 */
const DECISIONS: Record<string, string[]> = {
  decisions: [],
  observations: ['browser.observe'],
  actions: ['browser.act'],
  waits: ['browser.wait'],
  network: ['network.requests', 'network.request_detail'],
  finish: ['verification.finish'],
  'steps/:stepId/progress': ['verification.record'],
  'steps/:stepId/finish': ['verification.finish'],
  'steps/:stepId/block': ['verification.block'],
  interventions: ['verification.intervene'],
};
/** 公共凭据至少授权一个接入面；领域服务继续核对每个动作的 scope 和归属。 */
export function externalPrincipal(
  request: FastifyRequest,
  credentials: PublicCredential[],
) {
  for (const channel of ['browser', 'verification'] as const) {
    try {
      return authenticatePublic(
        request.headers.authorization,
        channel,
        credentials,
      );
    } catch (error) {
      if (!(error instanceof ApiError) || error.statusCode !== 403) throw error;
    }
  }
  throw new ApiError(403, 'SCOPE_FORBIDDEN', '未授权公共接入');
}
/** HTTP 适配层只做严格解析和别名匹配，版本、幂等和状态门禁全部交给领域层。 */
export function registerExternalRoutes(
  app: FastifyInstance,
  credentials: PublicCredential[],
  service: ExternalExecution,
) {
  const principal = (request: FastifyRequest) =>
    externalPrincipal(request, credentials);
  const parse = (
    request: FastifyRequest,
    type: ExternalExecutionRequest['type'],
  ) => {
    if (
      !request.body ||
      typeof request.body !== 'object' ||
      Array.isArray(request.body) ||
      'type' in request.body
    )
      throw new ApiError(
        400,
        'INVALID_INPUT',
        '正文需要公开操作参数，不接受内部类型字段',
      );
    const input = { ...request.body, type };
    if (!validateExternalExecutionRequest(input))
      throw new ApiError(
        400,
        'INVALID_INPUT',
        '操作参数不符合 ExternalExecutionRequest',
      );
    return input;
  };
  app.get('/v3/execution/schema', (request) => {
    principal(request);
    return {
      request: externalExecutionRequestSchema,
      decision: agentDecisionSchema,
      result: externalExecutionResultSchema,
    };
  });
  app.post('/v3/browser/sessions', async (request, reply) => {
    const who = principal(request),
      input = parse(request, 'open');
    if (input.type !== 'open') throw new Error('输入类型不匹配');
    return reply.code(202).send(await service.open(who, input));
  });
  app.post<{ Params: { runId: string } }>(
    '/v3/runs/:runId/controller',
    async (request, reply) => {
      const who = principal(request),
        input = parse(request, 'bind');
      if (input.type !== 'bind') throw new Error('输入类型不匹配');
      return reply
        .code(202)
        .send(await service.bind(who, request.params.runId, input));
    },
  );
  for (const path of ['/v3/controllers/:id', '/v3/controllers/:id/context'])
    app.get<{ Params: { id: string } }>(path, (request) => {
      const who = principal(request);
      if (Object.keys(request.query as object).length)
        throw new ApiError(400, 'INVALID_INPUT', '读取上下文不接受额外参数');
      return service.view(who, request.params.id);
    });
  for (const type of ['touch', 'close'] as const)
    app.post<{ Params: { id: string } }>(
      `/v3/controllers/:id/${type}`,
      (request) => {
        const who = principal(request),
          input = parse(request, type);
        if (input.type !== 'touch' && input.type !== 'close')
          throw new Error('输入类型不匹配');
        return service.control(who, request.params.id, input);
      },
    );
  for (const [path, types] of Object.entries(DECISIONS))
    app.post<{ Params: { id: string; stepId?: string } }>(
      `/v3/controllers/:id/${path}`,
      async (request, reply) => {
        const who = principal(request),
          input = parse(request, 'decide');
        if (input.type !== 'decide') throw new Error('输入类型不匹配');
        if (types.length && !types.includes(input.decision.type))
          throw new ApiError(400, 'INVALID_INPUT', '此路径不支持指定决定类型');
        if (request.params.stepId && input.stepId !== request.params.stepId)
          throw new ApiError(
            400,
            'INVALID_INPUT',
            '路径和正文的步骤身份必须一致',
          );
        return reply
          .code(202)
          .send(await service.decide(who, request.params.id, input));
      },
    );
}
