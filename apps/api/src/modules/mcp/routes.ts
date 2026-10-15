import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  mcpToolSchemas,
  mcpInputValidators,
  mcpOutputValidators,
} from '@proofrun/contracts';
import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from '../../config.js';
import type { Database } from '../../db.js';
import { ApiError, digest } from '../../domain.js';
import type { CaseV2Service } from '../cases/v2.js';
import type { ArtifactStore } from '../reports/artifacts.js';
import {
  authenticateClient,
  type IntegrationClient,
  type IntegrationConfig,
} from '../integrations/config.js';
import { IntegrationService } from '../integrations/service.js';
import type { NotificationService } from '../notifications/service.js';

/** 二进制经 base64 后仍保持有界；更大的 trace 使用原有证据下载入口。 */
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
/** 描述帮助模型遵守单 case 与 HITL 权限边界；不把人工完成解释为业务验收通过。 */
const DESCRIPTIONS: Record<string, string> = {
  proofrun_capabilities_get: '查询 v2 case 能力、允许的通知绑定和资源限制。',
  proofrun_case_validate: '只校验并编译 case，不创建任务或执行测试。',
  proofrun_case_submit:
    '提交一个 v2 case 并立即返回；caseId 幂等，等待人工时由通知服务发送链接。',
  proofrun_case_get:
    '查询本客户端的 case、人工请求和通知状态，不返回人工操作凭据。FAILED 是测试结果，不是工具调用失败。',
  proofrun_case_cancel: '取消整例的所有执行组。',
  proofrun_case_rerun:
    '使用新的 caseId 重跑，复用原环境和通知绑定；可选择原预算。',
  proofrun_evidence_read:
    '读取本 case 已交付结果引用的证据，校验 SHA-256；单份最多 8 MiB。',
};
const MUTATIONS = new Set([
  'proofrun_case_submit',
  'proofrun_case_cancel',
  'proofrun_case_rerun',
]);

/** 读取前核对 case 归属，读取后核对摘要；文件内容不被解释为工具指令。 */
async function evidence(
  db: Database,
  cases: CaseV2Service,
  artifacts: ArtifactStore,
  caseId: string,
  artifactId: string,
): Promise<CallToolResult> {
  await cases.requireEvidence(caseId, artifactId);
  const row = (
    await db.query('SELECT hash,size FROM pr_artifacts WHERE id=$1', [
      artifactId,
    ])
  ).rows[0];
  if (!row) throw new ApiError(404, 'EVIDENCE_MISSING', '证据不存在');
  if (Number(row.size ?? 0) > MAX_EVIDENCE_BYTES)
    throw new ApiError(413, 'EVIDENCE_TOO_LARGE', 'MCP 证据上限为 8 MiB');
  const stored = await artifacts.read(artifactId);
  const chunks: Buffer[] = [];
  let size = 0;
  if (Buffer.isBuffer(stored.body)) {
    size = stored.body.length;
    chunks.push(stored.body);
  } else
    for await (const chunk of stored.body) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_EVIDENCE_BYTES)
        throw new ApiError(413, 'EVIDENCE_TOO_LARGE', 'MCP 证据上限为 8 MiB');
      chunks.push(bytes);
    }
  if (size > MAX_EVIDENCE_BYTES)
    throw new ApiError(413, 'EVIDENCE_TOO_LARGE', 'MCP 证据上限为 8 MiB');
  const body = Buffer.concat(chunks);
  if (digest(body) !== row.hash)
    throw new ApiError(422, 'EVIDENCE_HASH_MISMATCH', '证据摘要校验失败');
  const metadata = {
    caseId,
    artifactId,
    mimeType: stored.contentType,
    sha256: row.hash,
    size,
  };
  if (!mcpOutputValidators.proofrun_evidence_read!(metadata))
    throw new ApiError(500, 'INVALID_TOOL_RESULT', '证据元数据不符合契约');
  return {
    structuredContent: metadata,
    content: [
      { type: 'text', text: JSON.stringify(metadata) },
      stored.contentType === 'image/png'
        ? {
            type: 'image',
            mimeType: 'image/png',
            data: body.toString('base64'),
          }
        : { type: 'text', text: body.toString('utf8') },
    ],
  };
}

/** 官方 SDK 提供无状态 Streamable HTTP；每个请求独立鉴权，状态均留在数据库中。 */
export function registerIntegrationRoutes(
  app: FastifyInstance,
  config: ApiConfig,
  db: Database,
  cases: CaseV2Service,
  artifacts: ArtifactStore,
  notifications: NotificationService,
): void {
  const integrations = config.integrations as IntegrationConfig;
  const service = new IntegrationService(db, cases, integrations);
  const servers = new Set<Server>();
  app.addHook('onClose', async () => {
    await Promise.all([...servers].map((server) => server.close()));
  });
  app.post('/v1/integrations/cases', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const client = authenticateClient(
      integrations,
      request.headers.authorization,
    );
    const result = await service.submit(client, request.body);
    return reply.code(202).send(result);
  });
  app.get<{ Params: { id: string } }>(
    '/v1/integrations/notifications/:id/view',
    async (request, reply) => {
      reply
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer');
      return notifications.view(
        request.params.id,
        request.headers.authorization,
      );
    },
  );
  /** 统一工具入口；输出与工具列表一样由 contracts 校验。 */
  const call = async (
    client: IntegrationClient,
    name: string,
    input: any,
  ): Promise<CallToolResult> => {
    let started = false;
    let completed = false;
    try {
      if (
        !Object.hasOwn(mcpInputValidators, name) ||
        !mcpInputValidators[name]!(input)
      )
        throw new ApiError(
          400,
          'INVALID_TOOL_ARGUMENTS',
          '工具名称或参数不符合契约',
        );
      let value: any;
      started = true;
      switch (name) {
        case 'proofrun_capabilities_get':
          value = {
            caseProtocol: 'v2',
            notificationProtocol: 'proofrun.notification.v1',
            configured: !!config.caseProfile,
            bindingReadiness: await service.readiness(client),
            bindingRefs: client.bindingRefs,
            defaultBindingRef: client.defaultBindingRef,
            executionModes: ['llm', 'jev', 'parallel'],
            limits: { casesPerSubmit: 1, evidenceBytes: MAX_EVIDENCE_BYTES },
          };
          break;
        case 'proofrun_case_validate':
          value = await cases.validate(input.case);
          break;
        case 'proofrun_case_submit':
          value = await service.submit(client, input);
          break;
        case 'proofrun_case_get':
          value = await service.get(client, input.caseId);
          break;
        case 'proofrun_case_cancel':
          value = await service.cancel(client, input.caseId);
          break;
        case 'proofrun_case_rerun':
          value = await service.rerun(
            client,
            input.caseId,
            input.newCaseId,
            input.budgetMode,
          );
          break;
        case 'proofrun_evidence_read': {
          await service.owned(client, input.caseId);
          return await evidence(
            db,
            cases,
            artifacts,
            input.caseId,
            input.artifactId,
          );
        }
      }
      completed = true;
      if (!mcpOutputValidators[name]!(value))
        throw new ApiError(500, 'INVALID_TOOL_RESULT', '工具结果不符合契约');
      return {
        structuredContent: value,
        content: [{ type: 'text', text: JSON.stringify(value) }],
      };
    } catch (error) {
      const known = error instanceof ApiError;
      const rejectedBeforeWrite =
        known &&
        [
          'BINDING_UNAVAILABLE',
          'BINDING_NOT_READY',
          'CASE_NOT_CONFIGURED',
        ].includes(error.code);
      const candidateId =
        input?.case?.caseId ?? input?.newCaseId ?? input?.caseId;
      const effect =
        !MUTATIONS.has(name) ||
        !started ||
        rejectedBeforeWrite ||
        (known && error.statusCode < 500)
          ? 'none'
          : completed
            ? 'committed'
            : 'unknown';
      const result = {
        code: known ? error.code : 'INTERNAL_ERROR',
        message: known
          ? error.message
          : '工具调用失败，请查询 case 状态后使用相同身份重试',
        retryable: !known || error.statusCode >= 500,
        effect,
        ...(typeof candidateId === 'string' && candidateId.length <= 80
          ? { caseId: candidateId }
          : {}),
      };
      return {
        isError: true,
        structuredContent: result,
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    }
  };
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (request, reply) => {
      const client = authenticateClient(
        integrations,
        request.headers.authorization,
      );
      const origin = request.headers.origin;
      if (origin && ![config.publicUrl, config.consoleUrl].includes(origin))
        throw new ApiError(403, 'ORIGIN_FORBIDDEN', 'Origin not allowed');
      if (request.method !== 'POST')
        return reply
          .header('Allow', 'POST')
          .code(405)
          .send({ code: 'METHOD_NOT_ALLOWED' });
      const server = new Server(
        { name: 'proofrun', version: '0.1.0' },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: Object.entries(mcpToolSchemas).map(([name, schema]) => ({
          name,
          description: DESCRIPTIONS[name],
          ...schema,
          annotations: {
            readOnlyHint: !MUTATIONS.has(name),
            destructiveHint: name === 'proofrun_case_cancel',
            idempotentHint: true,
            openWorldHint: MUTATIONS.has(name),
          },
        })),
      }));
      server.setRequestHandler(CallToolRequestSchema, (message) =>
        call(client, message.params.name, message.params.arguments ?? {}),
      );
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      // SDK 的可选回调声明尚未适配 exactOptionalPropertyTypes；运行时为其官方传输实现。
      await server.connect(transport as unknown as Transport);
      servers.add(server);
      reply.raw.setHeader('Cache-Control', 'no-store');
      reply.raw.setHeader('X-Content-Type-Options', 'nosniff');
      reply.hijack();
      reply.raw.once('close', () => {
        servers.delete(server);
        void server.close();
      });
      await transport.handleRequest(request.raw, reply.raw, request.body);
    },
  });
}
