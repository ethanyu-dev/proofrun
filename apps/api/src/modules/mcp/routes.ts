import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  taskMcpTools,
  executionMcpTools,
  executionMcpOperationSchema,
} from '@proofrun/contracts';
import { McpExecutionTools, executionTool } from './execution-tools.js';
import type { ApiConfig } from '../../config.js';
import { ApiError } from '../../domain.js';
import {
  authenticatePublic,
  validatePublicCredentials,
  type PublicChannel,
} from '../public-execution/auth.js';
import {
  PublicInputError,
  PublicTaskService,
  toolScope,
} from '../public-execution/service.js';
import { registerExternalRoutes } from '../external-execution/routes.js';
import type { ExternalExecution } from '../external-execution/service.js';
import { TASK_MCP_INSTRUCTIONS } from './instructions.js';

/** 附件资源只能引用固定路径结构，不接受任意 URL 或本地路径。 */
const EVIDENCE_URI =
  /^proofrun:\/\/runs\/([A-Za-z0-9_-]{1,160})\/evidence\/([A-Za-z0-9_-]{1,128})$/;
/** 任务级工具只有提交、取消和重跑会修改业务状态。 */
const WRITES = new Set([
  'browser_task_submit',
  'browser_task_cancel',
  'verification_submit_cases',
  'verification_cancel_run',
  'verification_rerun_cases',
]);

/** 不回传未知异常正文；服务日志与调用方结构化错误分离。 */
function publicError(error: unknown) {
  return {
    code: error instanceof ApiError ? error.code : 'SERVICE_UNAVAILABLE',
    message: error instanceof ApiError ? error.message : '服务暂不可用',
    retryable: error instanceof ApiError ? error.statusCode >= 500 : true,
    ...(error instanceof PublicInputError ? { details: error.details } : {}),
  };
}

/** 无状态 MCP 连接只负责协议，全部持久身份与重试结果由公共领域服务管理。 */
export async function registerTaskMcp(
  app: FastifyInstance,
  config: ApiConfig,
  service: PublicTaskService,
  external?: ExternalExecution,
) {
  if (!config.publicCredentials) return;
  const credentials = validatePublicCredentials(config.publicCredentials);
  const operations = external
    ? new McpExecutionTools(external, service)
    : undefined;
  const tools = [
    ...taskMcpTools.map((tool) =>
      external && tool.name.endsWith('_operation_get')
        ? {
            ...tool,
            outputSchema: {
              ...tool.outputSchema,
              anyOf: [...tool.outputSchema.anyOf, executionMcpOperationSchema],
            },
          }
        : tool,
    ),
    ...(external ? executionMcpTools : []),
  ];
  const scopeFor = (name: string) =>
    executionTool(name)?.scope ?? toolScope(name);
  const writes = (name: string) =>
    WRITES.has(name) ||
    (!!executionTool(name) && executionTool(name)!.request !== 'view');
  await app.register(async (routes) => {
    routes.setErrorHandler((error, _request, reply) => {
      if (
        !(error instanceof ApiError) &&
        !(error as { statusCode?: number }).statusCode
      )
        routes.log.error({ err: error }, '公共接入失败');
      const status =
        error instanceof ApiError
          ? error.statusCode
          : ((error as { statusCode?: number }).statusCode ?? 503);
      return reply.code(status).send(
        error instanceof ApiError
          ? publicError(error)
          : {
              code: status < 500 ? 'INVALID_INPUT' : 'SERVICE_UNAVAILABLE',
              message: status < 500 ? '请求格式无效' : '服务暂不可用',
              retryable: status >= 500,
            },
      );
    });
    /** 限制来源与 Host，防止浏览器跨站提交；不信任转发头改变授权来源。 */
    routes.addHook('onRequest', async (request, reply) => {
      reply
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff');
      const origin = request.headers.origin;
      if (origin && ![config.publicUrl, config.consoleUrl].includes(origin))
        throw new ApiError(403, 'ORIGIN_FORBIDDEN', '来源不受信任');
      const allowed = new Set([new URL(config.publicUrl).host]);
      const address = routes.server.address();
      if (
        address &&
        typeof address === 'object' &&
        ['127.0.0.1', 'localhost', '::1'].includes(config.host)
      ) {
        allowed.add(`127.0.0.1:${address.port}`);
        allowed.add(`localhost:${address.port}`);
        allowed.add(`[::1]:${address.port}`);
      }
      if (!request.headers.host || !allowed.has(request.headers.host))
        throw new ApiError(403, 'HOST_FORBIDDEN', '请求 Host 不受信任');
    });
    if (external) registerExternalRoutes(routes, credentials, external);
    for (const channel of ['browser', 'verification'] as const) {
      routes.route({
        method: ['POST', 'GET', 'DELETE'],
        url: `/mcp/${channel}`,
        handler: async (request, reply) => {
          const principal = authenticatePublic(
            request.headers.authorization,
            channel,
            credentials,
          );
          const server = new Server(
            { name: `proofrun-${channel}`, version: '0.1.0' },
            {
              capabilities: { tools: {}, resources: {} },
              instructions: TASK_MCP_INSTRUCTIONS[channel],
            },
          );
          server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: tools
              .filter(
                (tool: { name: string }) =>
                  tool.name.startsWith(`${channel}_`) &&
                  (!scopeFor(tool.name) ||
                    principal.scopes.includes(scopeFor(tool.name)!)),
              )
              .map(
                (tool: {
                  name: string;
                  description: string;
                  inputSchema: Record<string, unknown>;
                  outputSchema: Record<string, unknown>;
                }) => ({
                  ...tool,
                  inputSchema: tool.inputSchema as Tool['inputSchema'],
                  outputSchema: tool.outputSchema as Tool['outputSchema'],
                  annotations: {
                    readOnlyHint: !writes(tool.name),
                    destructiveHint: writes(tool.name),
                    idempotentHint: true,
                    openWorldHint: writes(tool.name),
                  },
                }),
              ),
          }));
          server.setRequestHandler(CallToolRequestSchema, async (call) => {
            try {
              const operated = await operations?.execute(
                principal,
                channel,
                call.params.name,
                call.params.arguments ?? {},
              );
              const result =
                operated ??
                (await service.execute(
                  principal,
                  channel,
                  call.params.name,
                  call.params.arguments ?? {},
                ));
              const data = result.data as Record<string, unknown>;
              if (typeof data.imageBase64 === 'string') {
                const { imageBase64, ...metadata } = data;
                return {
                  structuredContent: { ...result, data: metadata },
                  content: [
                    { type: 'text' as const, text: JSON.stringify(metadata) },
                    {
                      type: 'image' as const,
                      mimeType: 'image/png',
                      data: imageBase64,
                    },
                  ],
                };
              }
              return {
                structuredContent: result,
                content: [
                  { type: 'text' as const, text: JSON.stringify(result) },
                ],
              };
            } catch (error) {
              if (!(error instanceof ApiError))
                routes.log.error({ err: error }, 'MCP 工具调用失败');
              const failure = publicError(error);
              return {
                isError: true,
                structuredContent: failure,
                content: [
                  { type: 'text' as const, text: JSON.stringify(failure) },
                ],
              };
            }
          });
          server.setRequestHandler(ListResourcesRequestSchema, async () => ({
            resources: [
              {
                uri: 'proofrun://guides/tasks',
                name: '任务编写与调用说明',
                mimeType: 'text/plain',
              },
              ...(channel === 'verification'
                ? [
                    {
                      uri: 'proofrun://schemas/case-v2',
                      name: 'Case v2 输入规范',
                      mimeType: 'application/json',
                    },
                  ]
                : []),
            ],
          }));
          server.setRequestHandler(
            ListResourceTemplatesRequestSchema,
            async () => ({
              resourceTemplates: principal.scopes.includes('evidence:read')
                ? [
                    {
                      uriTemplate:
                        'proofrun://runs/{runId}/evidence/{evidenceId}',
                      name: '运行证据',
                      description:
                        '需要相同调用方权限；大附件使用返回的受保护下载地址',
                    },
                  ]
                : [],
            }),
          );
          server.setRequestHandler(ReadResourceRequestSchema, async (call) => {
            try {
              if (call.params.uri === 'proofrun://guides/tasks')
                return {
                  contents: [
                    {
                      uri: call.params.uri,
                      mimeType: 'text/plain',
                      text: TASK_MCP_INSTRUCTIONS[channel],
                    },
                  ],
                };
              if (
                call.params.uri === 'proofrun://schemas/case-v2' &&
                channel === 'verification'
              ) {
                const schema = taskMcpTools.find(
                  (tool: { name: string }) =>
                    tool.name === 'verification_submit_cases',
                )!.inputSchema.properties.cases.items;
                return {
                  contents: [
                    {
                      uri: call.params.uri,
                      mimeType: 'application/json',
                      text: JSON.stringify(schema),
                    },
                  ],
                };
              }
              const match = EVIDENCE_URI.exec(call.params.uri);
              if (!match)
                throw new ApiError(404, 'RESOURCE_NOT_FOUND', '资源不存在');
              const result = await service.execute(
                principal,
                channel,
                channel === 'browser'
                  ? 'browser_evidence_read'
                  : 'verification_read_evidence',
                {
                  runId: match[1],
                  evidenceId: match[2],
                  representation: 'content',
                },
              );
              const data = result.data as Record<string, unknown>;
              return {
                contents: [
                  typeof data.imageBase64 === 'string'
                    ? {
                        uri: call.params.uri,
                        mimeType: 'image/png',
                        blob: data.imageBase64,
                      }
                    : {
                        uri: call.params.uri,
                        mimeType: 'application/json',
                        text: JSON.stringify(data),
                      },
                ],
              };
            } catch (error) {
              if (!(error instanceof ApiError))
                routes.log.error({ err: error }, 'MCP 资源读取失败');
              const failure = publicError(error);
              throw new McpError(
                error instanceof ApiError && error.statusCode < 500
                  ? ErrorCode.InvalidParams
                  : ErrorCode.InternalError,
                failure.message,
                failure,
              );
            }
          });
          const transport = new StreamableHTTPServerTransport({
            enableJsonResponse: true,
          });
          // SDK 的可选回调未启用 exactOptionalPropertyTypes；运行时仍使用原始 Transport。
          await server.connect(transport as Parameters<Server['connect']>[0]);
          reply.hijack();
          // SDK 写原始响应，Fastify 的普通响应头不会自动应用。
          reply.raw.setHeader('Cache-Control', 'no-store');
          reply.raw.setHeader('X-Content-Type-Options', 'nosniff');
          reply.raw.on('close', () => {
            void server.close();
          });
          await transport.handleRequest(request.raw, reply.raw, request.body);
        },
      });
    }

    /** 固定路由直接调用同一工具服务，避免维护第二套参数与权限规则。 */
    const route = (
      method: 'GET' | 'POST',
      url: string,
      channel: PublicChannel,
      name: string,
    ) => {
      routes.route({
        method,
        url,
        handler: async (request, reply) => {
          const principal = authenticatePublic(
            request.headers.authorization,
            channel,
            credentials,
          );
          const raw = method === 'GET' ? request.query : request.body;
          const input = argumentsFor(request, raw);
          const result = await service.execute(principal, channel, name, input);
          return reply
            .code(
              method === 'POST' &&
                [
                  'browser_task_submit',
                  'verification_submit_cases',
                  'verification_rerun_cases',
                ].includes(name)
                ? 202
                : 200,
            )
            .send(result);
        },
      });
    };
    route(
      'GET',
      '/v3/browser/capabilities',
      'browser',
      'browser_get_capabilities',
    );
    route('POST', '/v3/browser/tasks', 'browser', 'browser_task_submit');
    route(
      'GET',
      '/v3/verification/capabilities',
      'verification',
      'verification_get_capabilities',
    );
    route(
      'POST',
      '/v3/verification/requests/validate',
      'verification',
      'verification_validate_cases',
    );
    route(
      'POST',
      '/v3/verification/requests',
      'verification',
      'verification_submit_cases',
    );
    route(
      'GET',
      '/v3/verification/requests/:requestId',
      'verification',
      'verification_get_request',
    );
    route(
      'POST',
      '/v3/verification/requests/:requestId/reruns',
      'verification',
      'verification_rerun_cases',
    );
    for (const [method, url, operation] of [
      ['GET', '/v3/runs/:runId', 'get'],
      ['POST', '/v3/runs/:runId/cancel', 'cancel'],
      ['GET', '/v3/operations/:operationId', 'operation'],
      ['GET', '/v3/runs/:runId/evidence/:evidenceId', 'evidence'],
      ['GET', '/v3/runs/:runId/evidence/:evidenceId/download', 'download'],
    ] as const) {
      routes.route({
        method,
        url,
        handler: async (request, reply) => {
          // 共享路径仍要求凭据至少获授权一个接入面，不从 URL 参数接收 principal。
          let principal;
          for (const channel of ['browser', 'verification'] as const) {
            try {
              principal = authenticatePublic(
                request.headers.authorization,
                channel,
                credentials,
              );
              break;
            } catch (error) {
              if (!(error instanceof ApiError) || error.statusCode !== 403)
                throw error;
            }
          }
          if (!principal)
            throw new ApiError(403, 'SCOPE_FORBIDDEN', '未授权公共接入');
          const input = argumentsFor(
            request,
            method === 'GET' ? request.query : request.body,
          );
          if (operation === 'operation' && external) {
            if (Object.keys(input).some((key) => key !== 'operationId'))
              throw new ApiError(
                400,
                'INVALID_INPUT',
                '操作查询不接受额外参数',
              );
            const receipt = await external.operation(
              principal,
              String(input.operationId),
            );
            if (receipt) return receipt;
          }
          let channel = principal.channels[0]!;
          if (operation === 'get' || operation === 'cancel')
            channel = await service.channelForRun(
              principal.principalId,
              String(input.runId),
            );
          if (!principal.channels.includes(channel))
            throw new ApiError(403, 'SCOPE_FORBIDDEN', '凭据未授权此任务类型');
          if (operation === 'download') {
            // 与 metadata 工具相同的校验和权限，避免下载路径绕过证据范围。
            await service.execute(
              principal,
              channel,
              channel === 'browser'
                ? 'browser_evidence_read'
                : 'verification_read_evidence',
              input,
            );
            const file = await service.evidence.download(
              principal.principalId,
              input as { runId: string; evidenceId: string },
            );
            return reply
              .header(
                'Content-Disposition',
                `attachment; filename="${String(input.evidenceId)}"`,
              )
              .header('ETag', `"${file.metadata.sha256}"`)
              .type(file.contentType)
              .send(file.body);
          }
          const name =
            operation === 'operation'
              ? `${channel}_operation_get`
              : operation === 'evidence'
                ? channel === 'browser'
                  ? 'browser_evidence_read'
                  : 'verification_read_evidence'
                : channel === 'browser'
                  ? `browser_task_${operation}`
                  : operation === 'get'
                    ? 'verification_get_run'
                    : 'verification_cancel_run';
          return service.execute(principal, channel, name, input);
        },
      });
    }
  });
}

/** 数字查询项显式转换，其他未知参数交给同源 Schema 拒绝；路径身份不能被正文覆盖。 */
function argumentsFor(
  request: FastifyRequest,
  raw: unknown,
): Record<string, unknown> {
  if (
    raw !== undefined &&
    (!raw || typeof raw !== 'object' || Array.isArray(raw))
  )
    throw new ApiError(400, 'INVALID_INPUT', '请求必须是对象');
  const input = { ...((raw as Record<string, unknown>) ?? {}) };
  for (const [key, value] of Object.entries(
    request.params as Record<string, string>,
  )) {
    if (Object.hasOwn(input, key))
      throw new ApiError(
        400,
        'INVALID_INPUT',
        '正文或查询参数不得重复路径身份',
      );
    input[key] = value;
  }
  if (request.method === 'GET')
    for (const key of ['limit', 'offset'])
      if (typeof input[key] === 'string') {
        if (!/^\d+$/.test(input[key]))
          throw new ApiError(400, 'INVALID_INPUT', '分页参数必须是非负整数');
        input[key] = Number(input[key]);
      }
  return input;
}
