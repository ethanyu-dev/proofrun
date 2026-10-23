import { TaskLifecycle } from './modules/tasks/lifecycle.js';
import { RequestAnalyses } from './modules/reports/request-analysis.js';
import { analysisRoutes } from './modules/reports/analysis-routes.js';
import { dashboardStatistics } from './modules/reports/dashboard.js';
import { RequestReader } from './modules/requests/reader.js';
import { RequestService } from './modules/requests/service.js';
import { IdentityLibrary } from './modules/identities/library.js';
import { IdentitySelection } from './modules/identities/selection.js';
import { identityMetrics } from './modules/identities/metrics.js';
import { IdentitySettings } from './modules/identities/settings.js';
import Fastify, { type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import type { Readable } from 'node:stream';
import {
  protocolVersion,
  validateVerificationTask,
  validateModelCallWrite,
  validateNodeRoutingWrite,
} from '@proofrun/contracts';
import { loadConfig, type ApiConfig } from './config.js';
import { Database } from './db.js';
import {
  ApiError,
  bearer,
  MAX_MESSAGE_BYTES,
  parseRequest,
  requireToken,
} from './domain.js';
import { NodeRouting } from './modules/nodes/routing.js';
import { NodeRegistry } from './modules/nodes/registry.js';
import { NodeGateway } from './modules/nodes/gateway.js';
import { ArtifactStore } from './modules/reports/artifacts.js';
import { Coordinator } from './modules/scheduling/coordinator.js';
import { ExecutionControl } from './modules/scheduling/control.js';
import { NodeProfiles } from './modules/nodes/profiles.js';
import { HitlService } from './modules/hitl/service.js';
import { CaseNotifications } from './modules/notifications/service.js';
import { TaskReader } from './modules/tasks/reader.js';
import { LiveService } from './modules/hitl/live.js';
import { ModelCalls } from './modules/reports/model-calls.js';
import { CaseV2Service } from './modules/cases/v2.js';
import { CaseService } from './modules/cases/service.js';
import { registerPublicDocs } from './modules/docs/routes.js';

/** 路由参数只参与参数化查询；证据路径另有独立的身份校验。 */
type IdParams = { id: string };
type CommandParams = { id: string; commandId: string };

/** 装配单实例控制面；返回前完成数据库迁移和实例锁获取。 */
export async function buildApp(
  config: ApiConfig = loadConfig(),
  options: { logger?: boolean } = {},
) {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : { redact: ['req.headers.authorization'] },
    bodyLimit: MAX_MESSAGE_BYTES,
  });
  const db = new Database(config.databaseUrl);
  try {
    await db.start();
  } catch (error) {
    await db.close().catch(() => {});
    throw error;
  }
  const registry = new NodeRegistry(db, config);
  const routing = new NodeRouting(db);
  const artifacts = new ArtifactStore(
    db,
    config.artifactDirectory,
    config.publicUrl,
  );
  const coordinator = new Coordinator(db, config, artifacts);
  const tasks = new TaskReader(db);
  const lifecycle = new TaskLifecycle(db);
  const cases = new CaseService(
    {
      submit: (definition) => coordinator.submit(definition),
      task: async (id) => {
        await lifecycle.visible(id);
        return coordinator.task(id);
      },
      cancel: (id) => coordinator.cancel(id),
    },
    config.caseProfile,
    config.publicUrl,
  );
  const identities = new IdentitySettings(db, config);
  const library = new IdentityLibrary(db, config);
  const selection = new IdentitySelection(db);
  coordinator.identityLibrary = library;
  const casesV2 = new CaseV2Service(
    coordinator,
    config.caseProfile,
    config.publicUrl,
    async (request) =>
      request && ['identity', 'pool', 'auto'].includes(request.mode)
        ? identities.catalog()
        : library.catalog(),
  );
  const requestReader = new RequestReader(db, config.publicUrl);
  const verificationRequests = new RequestService(
    casesV2,
    coordinator,
    requestReader,
  );
  const control = new ExecutionControl(
    db,
    config.adminToken,
    config.humanWaitMs,
  );
  const gateway = new NodeGateway(
    (connection, event) => coordinator.receive(connection, event),
    app.log,
  );
  coordinator.gateway = gateway;
  const nodeProfiles = new NodeProfiles(db, config, coordinator);
  const hitl = new HitlService(
    db,
    config,
    control,
    coordinator,
    gateway,
    library,
    nodeProfiles,
  );
  const live = new LiveService(db, gateway, config.adminToken);
  const notifications = new CaseNotifications(db, config, app.log);
  app.addHook('onReady', async () => notifications.start());
  const modelCalls = new ModelCalls(db);
  const authenticatedNodes = new WeakMap<
    FastifyRequest,
    { id: string; hash: string }
  >();
  const admin = async (
    request: FastifyRequest,
    reply: { header(name: string, value: string): unknown },
  ) => {
    requireToken(request.headers.authorization, config.adminToken);
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
  };
  app.get('/v1/admin/identities/metrics', { preHandler: admin }, () =>
    identityMetrics(db),
  );
  app.get<{ Querystring: Record<string, unknown> }>(
    '/v1/admin/statistics',
    { preHandler: admin },
    (request) => dashboardStatistics(db, request.query),
  );
  app.get('/v1/admin/identities/settings', { preHandler: admin }, () =>
    identities.view(),
  );
  app.post('/v1/admin/identities/settings', { preHandler: admin }, (request) =>
    identities.save(request.body),
  );
  app.post('/v1/admin/identities/test', { preHandler: admin }, (request) =>
    identities.test(request.body),
  );
  app.get('/v1/admin/identities', { preHandler: admin }, () =>
    identities.snapshot(),
  );
  app.post('/v1/admin/identities/refresh', { preHandler: admin }, async () => {
    const catalog = await identities.catalog(true);
    return {
      identities: catalog.identities.length,
      pools: catalog.pools.length,
      sites: catalog.sites.length,
    };
  });
  app.get('/v1/admin/identity-library', { preHandler: admin }, () =>
    library.list(),
  );
  app.post('/v1/admin/identity-library', { preHandler: admin }, (request) =>
    library.save(request.body),
  );
  app.post(
    '/v1/admin/identity-library/remove',
    { preHandler: admin },
    (request) => library.remove(request.body),
  );
  const worker = async (request: FastifyRequest) =>
    requireToken(request.headers.authorization, config.workerToken);
  app.post('/v1/worker/identity-selection/claim', { preHandler: worker }, () =>
    selection.claim(),
  );
  app.post(
    '/v1/worker/identity-selection/finish',
    { preHandler: worker },
    (request) => selection.finish(request.body),
  );
  const node = async (request: FastifyRequest) => {
    authenticatedNodes.set(
      request,
      await registry.authenticate(bearer(request.headers.authorization)),
    );
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError)
      return reply
        .code(error.statusCode)
        .send({ code: error.code, message: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply
        .code(status)
        .send({ code: 'INVALID_REQUEST', message: 'Invalid request body' });
    app.log.error({ err: error }, '控制面请求失败');
    return reply.code(503).send({
      code: 'CONTROL_PLANE_UNAVAILABLE',
      message: 'Control plane temporarily unavailable',
    });
  });
  app.addHook('onRequest', async () => {
    if (!db.healthy)
      throw new ApiError(
        503,
        'DATABASE_UNAVAILABLE',
        'Control-plane database ownership lost',
      );
  });
  registerPublicDocs(app);
  await app.register(websocket, {
    options: { maxPayload: MAX_MESSAGE_BYTES },
    // 统一接管退出顺序，避免默认关闭握手留下业务连接表之外的旧连接。
    preClose: closeTransports,
  });
  app.get('/health/live', async () => ({
    service: 'proofrun-api',
    status: 'alive',
    protocolVersion,
  }));
  app.get('/health/ready', async () => {
    await db.query('SELECT 1');
    return {
      service: 'proofrun-api',
      status: 'ready',
      capabilities: {
        nodeGateway: true,
        persistentQueue: true,
        executionWorkerProtocol: true,
        structuredCaseProtocol: true,
      },
    };
  });
  // 独立处理页首帧使用任务专属凭据；跨站页面不能借浏览器连接处理入口。
  app.get(
    '/v1/hitl/connect',
    {
      websocket: true,
      preValidation: async (request) => {
        const origin = request.headers.origin;
        const local =
          origin &&
          /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) &&
          new URL(origin).host === request.headers.host;
        if (
          origin !== new URL(config.consoleUrl ?? config.publicUrl).origin &&
          !local
        )
          throw new ApiError(
            403,
            'HITL_ORIGIN',
            'Invalid handling page origin',
          );
      },
    },
    (socket) => hitl.accept(socket),
  );
  app.get(
    '/v1/node-profiles/connect',
    {
      websocket: true,
      preValidation: async (request) => {
        const origin = request.headers.origin;
        const local =
          origin &&
          /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) &&
          new URL(origin).host === request.headers.host;
        if (
          origin !== new URL(config.consoleUrl ?? config.publicUrl).origin &&
          !local
        )
          throw new ApiError(
            403,
            'HITL_ORIGIN',
            'Invalid handling page origin',
          );
      },
    },
    (socket) => hitl.accept(socket, true),
  );
  app.get(
    '/v1/hitl/relay',
    { websocket: true, preValidation: node },
    (socket, request) =>
      hitl.relay(socket, authenticatedNodes.get(request)!.id),
  );
  app.get(
    '/v1/live/connect',
    {
      websocket: true,
      preValidation: async (request) => {
        const origin = request.headers.origin;
        const local =
          origin &&
          /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) &&
          new URL(origin).host === request.headers.host;
        if (
          origin !== new URL(config.consoleUrl ?? config.publicUrl).origin &&
          !local
        )
          throw new ApiError(403, 'LIVE_ORIGIN', 'Invalid viewer origin');
      },
    },
    (socket) => live.accept(socket),
  );
  app.get(
    '/v1/live/relay',
    { websocket: true, preValidation: node },
    (socket, request) =>
      live.relay(socket, authenticatedNodes.get(request)!.id),
  );
  app.get<{ Params: IdParams }>(
    '/v1/admin/executions/:id/live-frame',
    { preHandler: admin },
    (request) => live.snapshot(request.params.id),
  );
  app.get<{ Params: IdParams }>(
    '/v1/admin/executions/:id/intervention',
    { preHandler: admin },
    (request) => hitl.current(request.params.id),
  );
  app.get<{ Params: IdParams }>(
    '/v1/executions/:id/intervention',
    async (request, reply) => {
      await coordinator.execution(
        request.params.id,
        bearer(request.headers.authorization),
      );
      reply.header('Cache-Control', 'no-store');
      return hitl.current(request.params.id);
    },
  );
  app.post('/v1/node-pairings', { preHandler: admin }, async (request) => {
    const body = parseRequest(request.body, 'node.enroll');
    return registry.enroll(body.pool, body.name);
  });
  app.post('/v1/nodes/pair', async (request) => {
    const body = parseRequest(request.body, 'node.pair');
    const receipt = await registry.pair(
      body.nodeId,
      body.pool,
      body.pairingToken,
    );
    gateway.disconnect(body.nodeId);
    return receipt;
  });
  app.post<{ Params: IdParams }>(
    '/v1/nodes/:id/rotation',
    { preHandler: admin },
    (request) => registry.rotate(request.params.id),
  );
  app.post<{ Params: IdParams }>(
    '/v1/nodes/:id/routing',
    { preHandler: admin },
    (request) => {
      if (!validateNodeRoutingWrite(request.body))
        throw new ApiError(400, 'INVALID_ROUTING', '域名配置格式无效');
      return routing.save(request.params.id, request.body);
    },
  );
  // 模板维护的创建、恢复和关闭都需要 Console 鉴权，地址不携带可分享的处理令牌。
  app.post<{ Params: { id: string } }>(
    '/v1/nodes/:id/profile',
    { preHandler: admin },
    (request) => nodeProfiles.create(request.params.id, request.body),
  );
  app.get<{ Params: { id: string } }>(
    '/v1/nodes/:id/profile',
    { preHandler: admin },
    (request) => nodeProfiles.current(request.params.id),
  );
  app.get<{ Params: { id: string } }>(
    '/v1/node-profiles/:id',
    { preHandler: admin },
    (request) => nodeProfiles.status(request.params.id),
  );
  app.post<{ Params: { id: string } }>(
    '/v1/node-profiles/:id/close',
    { preHandler: admin },
    async (request) => {
      await nodeProfiles.finish(request.params.id, undefined, false);
      return { closing: true };
    },
  );
  app.get('/v1/nodes', { preHandler: admin }, async () => {
    const live = new Set(gateway.live().map((c) => c.nodeId));
    return {
      nodes: (await registry.list()).map((row) => ({
        ...row,
        online: live.has(row.id as string),
      })),
    };
  });
  app.post<{ Params: IdParams }>(
    '/v1/nodes/:id/revoke',
    { preHandler: admin },
    async (request) => {
      await coordinator.revokeNode(request.params.id);
      return { revoked: true };
    },
  );
  app.get(
    '/v1/nodes/connect',
    { websocket: true, preValidation: node },
    (socket, request) => {
      gateway.accept(socket, authenticatedNodes.get(request)!);
    },
  );
  // 上层只提交业务 case；原任务和节点入口继续服务内部控制台与执行组件。
  app.post('/v1/cases', { preHandler: admin }, async (request, reply) =>
    reply.code(202).send(await cases.submit(request.body)),
  );
  app.get<{ Params: IdParams }>(
    '/v1/cases/:id',
    { preHandler: admin },
    (request) => cases.get(request.params.id),
  );
  app.post<{ Params: IdParams }>(
    '/v1/cases/:id/cancel',
    { preHandler: admin },
    (request) => cases.cancel(request.params.id),
  );
  app.get<{ Params: IdParams & { artifactId: string } }>(
    '/v1/cases/:id/evidence/:artifactId',
    { preHandler: admin },
    async (request, reply) => {
      await cases.requireEvidence(request.params.id, request.params.artifactId);
      const artifact = await artifacts.read(request.params.artifactId);
      return reply.type(artifact.contentType).send(artifact.body);
    },
  );
  // 新版批量入口与旧单 case 协议并存，批内定义原子接收。
  app.post('/v2/cases', { preHandler: admin }, async (request, reply) =>
    reply
      .code(202)
      .send(
        Array.isArray(request.body)
          ? await casesV2.submit(request.body)
          : await verificationRequests.submit(request.body),
      ),
  );
  app.get('/v2/requests', { preHandler: admin }, (request) =>
    requestReader.list(request.query as Record<string, unknown>),
  );
  app.get<{ Params: IdParams }>(
    '/v2/requests/:id',
    { preHandler: admin },
    (request) => requestReader.get(request.params.id),
  );
  app.get<{ Params: IdParams }>(
    '/v2/requests/:id/report',
    { preHandler: admin },
    (request) => requestReader.get(request.params.id),
  );
  app.post<{ Params: IdParams }>(
    '/v2/requests/:id/rerun',
    { preHandler: admin },
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await verificationRequests.rerun(request.params.id, request.body),
        ),
  );
  app.get<{ Params: IdParams }>(
    '/v1/tasks/:id/requests',
    { preHandler: admin },
    (request) => requestReader.memberships(request.params.id),
  );
  app.get<{ Params: IdParams }>(
    '/v2/cases/:id/runs',
    { preHandler: admin },
    async (request) => {
      await coordinator.caseTask(request.params.id);
      return { runs: await coordinator.caseRuns(request.params.id) };
    },
  );
  app.post('/v1/tasks/delete', { preHandler: admin }, (request) =>
    lifecycle.remove((request.body as { ids?: unknown })?.ids),
  );
  app.post<{ Params: IdParams }>(
    '/v1/tasks/:id/delete',
    { preHandler: admin },
    (request) => lifecycle.remove([request.params.id]),
  );
  app.post('/v2/requests/delete', { preHandler: admin }, (request) =>
    lifecycle.remove((request.body as { ids?: unknown })?.ids, true),
  );
  app.post<{ Params: IdParams }>(
    '/v2/requests/:id/delete',
    { preHandler: admin },
    (request) => lifecycle.remove([request.params.id], true),
  );
  app.get<{ Params: IdParams }>(
    '/v2/cases/:id',
    { preHandler: admin },
    (request) =>
      casesV2.get(
        request.params.id,
        (request.query as { runId?: string }).runId,
      ),
  );
  app.post<{ Params: IdParams }>(
    '/v2/cases/:id/rerun',
    { preHandler: admin },
    async (request, reply) => {
      const body = request.body as
        | {
            caseId?: unknown;
            runId?: unknown;
            budgetMode?: 'current' | 'original';
            timeBudget?: unknown;
          }
        | undefined;
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some(
          (key) =>
            !['caseId', 'runId', 'budgetMode', 'timeBudget'].includes(key),
        ) ||
        (body.budgetMode !== undefined &&
          !['current', 'original'].includes(body.budgetMode)) ||
        (!('runId' in body) && !('caseId' in body)) ||
        ('runId' in body && 'caseId' in body)
      )
        throw new ApiError(
          400,
          'INVALID_RERUN',
          '重跑需要 runId，budgetMode 可选 current 或 original；旧 caseId 参数兼容为运行幂等键',
        );
      return reply
        .code(202)
        .send(
          await casesV2.rerun(
            request.params.id,
            body.runId ?? body.caseId,
            body.budgetMode,
            body.timeBudget,
          ),
        );
    },
  );
  app.post<{ Params: IdParams }>(
    '/v2/cases/:id/cancel',
    { preHandler: admin },
    (request) => casesV2.cancel(request.params.id),
  );
  app.get<{ Params: IdParams & { artifactId: string } }>(
    '/v2/cases/:id/evidence/:artifactId',
    { preHandler: admin },
    async (request, reply) => {
      await casesV2.requireEvidence(
        request.params.id,
        request.params.artifactId,
        (request.query as { runId?: string }).runId,
      );
      const artifact = await artifacts.read(request.params.artifactId);
      return reply.type(artifact.contentType).send(artifact.body);
    },
  );
  app.post<{ Params: IdParams }>('/v1/executions/:id/steps', (request) =>
    coordinator.recordSteps(
      request.params.id,
      bearer(request.headers.authorization),
      request.body,
    ),
  );
  app.post('/v1/tasks', { preHandler: admin }, async (request, reply) => {
    if (!validateVerificationTask(request.body))
      throw new ApiError(
        400,
        'INVALID_TASK',
        'Task does not match VerificationTask',
      );
    return reply.code(202).send(await coordinator.submit(request.body));
  });
  app.get<{ Querystring: Record<string, unknown> }>(
    '/v1/tasks',
    { preHandler: admin },
    (request) => tasks.list(request.query),
  );
  app.get<{ Params: IdParams }>(
    '/v1/tasks/:id',
    { preHandler: admin },
    async (request) => {
      await lifecycle.visible(request.params.id);
      return coordinator.task(request.params.id);
    },
  );
  app.post<{ Params: IdParams }>(
    '/v1/tasks/:id/rerun',
    { preHandler: admin },
    async (request, reply) => {
      const body = request.body as { runId?: unknown } | undefined;
      if (
        !body ||
        typeof body.runId !== 'string' ||
        Object.keys(body).length !== 1
      )
        throw new ApiError(400, 'INVALID_RERUN', '需要 runId');
      await lifecycle.visible(request.params.id);
      return reply
        .code(202)
        .send(await coordinator.rerun(request.params.id, body.runId));
    },
  );
  app.post<{ Params: IdParams }>(
    '/v1/tasks/:id/compare',
    { preHandler: admin },
    (request) => {
      const body = request.body as
        { comparisonId?: unknown; maxActions?: unknown } | undefined;
      if (
        !body ||
        typeof body.comparisonId !== 'string' ||
        Object.keys(body).some(
          (key) => !['comparisonId', 'maxActions'].includes(key),
        ) ||
        (body.maxActions !== undefined && typeof body.maxActions !== 'number')
      )
        throw new ApiError(400, 'INVALID_COMPARISON', '需要 comparisonId');
      return coordinator.compare(
        request.params.id,
        body.comparisonId,
        body.maxActions as number | undefined,
      );
    },
  );
  app.get<{ Params: IdParams }>(
    '/v1/tasks/:id/comparison',
    { preHandler: admin },
    async (request) => {
      await lifecycle.visible(request.params.id);
      return coordinator.comparison(request.params.id);
    },
  );
  app.post<{ Params: IdParams }>(
    '/v1/tasks/:id/cancel',
    { preHandler: admin },
    (request) => coordinator.cancel(request.params.id),
  );
  analysisRoutes(app, new RequestAnalyses(db, requestReader), admin, worker);
  app.post<{ Params: IdParams }>(
    '/v1/tasks/:id/account-feedback',
    { preHandler: admin },
    async (request) => {
      await coordinator.externalAccounts.feedback(
        request.params.id,
        request.body,
      );
      return coordinator.task(request.params.id);
    },
  );
  app.post('/v1/worker/claim', { preHandler: worker }, (request) => {
    const body = parseRequest(request.body, 'worker.claim');
    return coordinator.claim(
      body.workerId,
      body.structuredSteps === true,
      body.stepBudgetVersion,
      body.identityVersion,
      body.profileTabsVersion,
      body.executionPlanVersion,
    );
  });
  app.get<{ Params: IdParams }>('/v1/executions/:id', (request) =>
    coordinator.execution(
      request.params.id,
      bearer(request.headers.authorization),
    ),
  );
  app.post<{ Params: IdParams }>('/v1/executions/:id/heartbeat', (request) =>
    coordinator.heartbeatExecution(
      request.params.id,
      bearer(request.headers.authorization),
    ),
  );
  app.post<{ Params: { id: string; callId: string } }>(
    '/v1/executions/:id/model-calls/:callId',
    (request) => {
      if (!validateModelCallWrite(request.body))
        throw new ApiError(
          400,
          'INVALID_MODEL_CALL',
          'Invalid model call record',
        );
      return modelCalls.write(
        request.params.id,
        request.params.callId,
        bearer(request.headers.authorization),
        request.body,
      );
    },
  );
  app.get<{ Params: IdParams }>(
    '/v1/admin/executions/:id/model-calls',
    { preHandler: admin },
    (request) => modelCalls.list(request.params.id),
  );
  app.get<{ Params: { id: string; callId: string } }>(
    '/v1/admin/executions/:id/model-calls/:callId',
    { preHandler: admin },
    (request) => modelCalls.read(request.params.id, request.params.callId),
  );
  app.post<{ Params: IdParams }>(
    '/v1/executions/:id/commands',
    async (request, reply) => {
      const body = parseRequest(request.body, 'execution.command');
      return reply
        .code(202)
        .send(
          await coordinator.command(
            request.params.id,
            bearer(request.headers.authorization),
            body.commandId,
            body.timeoutMs,
            body.command,
            body.controlRevision,
            body.stepId,
          ),
        );
    },
  );
  app.get<{ Params: CommandParams }>(
    '/v1/executions/:id/commands/:commandId',
    (request) =>
      coordinator.commandResult(
        request.params.id,
        bearer(request.headers.authorization),
        request.params.commandId,
      ),
  );
  app.post<{ Params: IdParams }>('/v1/executions/:id/complete', (request) => {
    const body = parseRequest(request.body, 'execution.complete');
    return coordinator.complete(
      request.params.id,
      bearer(request.headers.authorization),
      body.report,
      body.controlRevision,
    );
  });
  // 管理员与 worker 使用各自入口，人工命令仍经同一队列、预算和节点去重。
  app.get<{ Params: IdParams }>(
    '/v1/admin/executions/:id/activity',
    { preHandler: admin },
    (request) => control.activity(request.params.id),
  );
  app.post<{ Params: IdParams }>(
    '/v1/admin/executions/:id/intervene',
    { preHandler: admin },
    (request) => {
      const body = parseRequest(request.body, 'execution.intervene');
      return control.change(
        request.params.id,
        null,
        'request',
        body.controlRevision ?? 0,
        body.reason,
        body.items,
        body.reasonCode,
        undefined,
        body.conditionKeys,
      );
    },
  );
  app.post<{ Params: IdParams }>(
    '/v1/admin/executions/:id/control',
    { preHandler: admin },
    (request) => {
      const body = parseRequest(request.body, 'execution.control');
      return control.change(
        request.params.id,
        null,
        body.action,
        body.controlRevision,
      );
    },
  );
  app.post<{ Params: IdParams }>(
    '/v1/admin/executions/:id/commands',
    { preHandler: admin },
    async (request, reply) => {
      const body = parseRequest(request.body, 'execution.command');
      return reply
        .code(202)
        .send(
          await coordinator.command(
            request.params.id,
            null,
            body.commandId,
            body.timeoutMs,
            body.command,
            body.controlRevision,
            body.stepId,
          ),
        );
    },
  );
  app.post<{ Params: IdParams }>('/v1/executions/:id/intervene', (request) => {
    const body = parseRequest(request.body, 'execution.intervene');
    return control.change(
      request.params.id,
      bearer(request.headers.authorization),
      'request',
      body.controlRevision ?? 0,
      body.reason,
      body.items,
      body.reasonCode,
      undefined,
      body.conditionKeys,
    );
  });
  app.post<{ Params: IdParams }>('/v1/executions/:id/control', (request) => {
    const body = parseRequest(request.body, 'execution.control');
    return control.change(
      request.params.id,
      bearer(request.headers.authorization),
      body.action,
      body.controlRevision,
    );
  });
  // PNG 保持为流；文件上限和摘要在 ArtifactStore 中逐块核实。
  app.addContentTypeParser('image/png', (_request, payload, done) =>
    done(null, payload),
  );
  app.addContentTypeParser(
    'application/vnd.proofrun.trace+json',
    (_request, payload, done) => done(null, payload),
  );
  app.put<{ Params: IdParams }>(
    '/v1/artifacts/:id',
    { preValidation: node },
    (request) => {
      if (
        !['image/png', 'application/vnd.proofrun.trace+json'].includes(
          request.headers['content-type'] ?? '',
        )
      )
        throw new ApiError(415, 'UNSUPPORTED_ARTIFACT', 'PNG required');
      const hash = request.headers['x-content-sha256'];
      if (typeof hash !== 'string')
        throw new ApiError(400, 'HASH_REQUIRED', 'X-Content-Sha256 required');
      return artifacts.put(
        authenticatedNodes.get(request)!.id,
        request.params.id,
        hash,
        request.body as Readable,
        request.headers['content-type'],
      );
    },
  );
  app.get<{ Params: IdParams }>(
    '/v1/artifacts/:id',
    { preHandler: admin },
    async (request, reply) => {
      const artifact = await artifacts.read(request.params.id);
      return reply.type(artifact.contentType).send(artifact.body);
    },
  );

  // 执行者可读取自己采集的截图供模型判断，不必获得能访问全平台证据的管理员凭据。
  app.get<{ Params: IdParams & { artifactId: string } }>(
    '/v1/executions/:id/artifacts/:artifactId',
    async (request, reply) => {
      await coordinator.execution(
        request.params.id,
        bearer(request.headers.authorization),
      );
      const artifact = await artifacts.read(
        request.params.artifactId,
        request.params.id,
      );
      return reply.type(artifact.contentType).send(artifact.body);
    },
  );

  let ticking: Promise<void> | undefined;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || ticking) return;
    ticking = coordinator
      .tick()
      .then(() => nodeProfiles.tick())
      .catch((error) => {
        app.log.error({ err: error }, '调度扫描失败');
        if (!db.healthy) void app.close();
      })
      .finally(() => {
        ticking = undefined;
      });
  }, config.tickMs);
  timer.unref();
  /** 停止调度后终止全部 WS，包括被替换的旧连接；事件落库完成后才能释放数据库。 */
  async function closeTransports() {
    stopped = true;
    clearInterval(timer);
    await notifications.close();
    await ticking;
    hitl.close();
    live.close();
    // 先取得网关在途事件的等待对象，连接关闭事件随后可能移除业务路由记录。
    const draining = gateway.close();
    for (const socket of app.websocketServer.clients) socket.terminate();
    await Promise.all([
      draining,
      new Promise<void>((resolve, reject) => {
        app.websocketServer.close((error) =>
          error ? reject(error) : resolve(),
        );
      }),
    ]);
  }
  app.addHook('onClose', async () => {
    await coordinator.externalAccounts.close();
    await db.close();
  });
  return app;
}
