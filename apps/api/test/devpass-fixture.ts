import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CompactEncrypt, importSPKI } from 'jose';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  schemas,
  type GetAccountInput,
  type GetAccountOutput,
  type ReleaseAccountInput,
} from '@dev-pass/contracts';
import type { DevPassConfig } from '../src/modules/account-providers/config.js';

/** 真实 MCP HTTP/JWE 的内存账号服务夹具；不替代 DevPass 数据库或真实业务平台验收。 */
export async function devPassFixture(directory: string) {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = await importSPKI(
    keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    'RSA-OAEP-256',
  );
  const tokenFile = join(directory, 'devpass-token');
  const privateFile = join(directory, 'devpass-private');
  await writeFile(tokenFile, 'fixture-token', { mode: 0o600 });
  await writeFile(
    privateFile,
    keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  const state = {
    version: 'material-1',
    /** 模拟材料接收方绑定错误；不改变已持久化的租约。 */
    wrongRecipient: false,
    /** 恢复旧租约时模拟服务端材料拒绝，不代表已经释放额度。 */
    replayError: null as 'MATERIAL_REVOKED' | 'TEMPORARY_UNAVAILABLE' | null,
    /** 明确未分配账号的业务响应，与传输超时分开验证。 */
    unavailable: null as 'NO_MATCH' | 'CAPACITY_EXHAUSTED' | null,
    capacity: 1,
    dropGet: false,
    dropRelease: false,
    requests: [] as GetAccountInput[],
    releases: [] as ReleaseAccountInput[],
    allocations: new Map<
      string,
      Extract<GetAccountOutput, { status: 'allocated' }>
    >(),
    released: new Set<string>(),
  };
  const http = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    if (req.headers.authorization !== 'Bearer fixture-token') {
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const server = new Server(
      { name: 'devpass-fixture', version: '1' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: 'getAccount', inputSchema: schemas.getInput },
        { name: 'releaseAccount', inputSchema: schemas.releaseInput },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      let result: Record<string, unknown>;
      if (request.params.name === 'getAccount') {
        const input = request.params.arguments as unknown as GetAccountInput;
        state.requests.push(input);
        let allocated = state.allocations.get(input.request_id);
        if (allocated && state.replayError) {
          result = {
            schema_version: '1',
            status: 'error',
            error: {
              code: state.replayError,
              message: '夹具拒绝恢复材料',
              retryable: state.replayError === 'TEMPORARY_UNAVAILABLE',
              retry_after_seconds: null,
            },
          };
        } else if (!allocated && state.unavailable) {
          result = {
            schema_version: '1',
            status: 'unavailable',
            reason: state.unavailable,
            message: '夹具无可用账号',
            retry_after_seconds: null,
          };
        } else if (
          !allocated &&
          [...state.allocations.values()].filter(
            (a) => !state.released.has(a.lease.id),
          ).length >= state.capacity
        ) {
          result = {
            schema_version: '1',
            status: 'unavailable',
            reason: 'CAPACITY_EXHAUSTED',
            message: '夹具账号忙碌',
            retry_after_seconds: 30,
          };
        } else {
          if (!allocated) {
            const lease = {
              id: `lease-${randomUUID()}`,
              issued_at: new Date().toISOString(),
              expires_at: new Date(
                Date.now() + input.duration_seconds! * 1000,
              ).toISOString(),
            };
            const material = {
              type: 'browser_cookies',
              cookies: [
                {
                  name: 'session',
                  value: 'fixture-private-cookie',
                  domain: new URL(input.origin).hostname,
                  host_only: true,
                  path: '/admin',
                  secure: true,
                  http_only: true,
                  same_site: 'Strict',
                  expires_at: null,
                },
              ],
            };
            const ciphertext = await new CompactEncrypt(
              new TextEncoder().encode(
                JSON.stringify({
                  schema_version: '1',
                  lease_id: lease.id,
                  account_id: 'account-1',
                  material_version: state.version,
                  recipient_id: state.wrongRecipient
                    ? 'another-client'
                    : 'proofrun-fixture',
                  origin: input.origin,
                  use_before: lease.expires_at,
                  material,
                }),
              ),
            )
              .setProtectedHeader({
                alg: 'RSA-OAEP-256',
                enc: 'A256GCM',
                kid: 'key-1',
                typ: 'devpass-material+jwe',
              })
              .encrypt(publicKey);
            allocated = {
              schema_version: '1',
              status: 'allocated',
              lease,
              account: {
                id: 'account-1',
                platform: input.platform,
                origin: input.origin,
                role_description: ['member'],
                note: '协议夹具',
                hitl_case: '需要时人工确认',
                concurrency: state.capacity,
                material: {
                  type: 'browser_cookies',
                  version: state.version,
                  expires_at: null,
                  delivery: {
                    format: 'jwe',
                    recipient_key_id: 'key-1',
                    ciphertext,
                  },
                },
              },
            };
            state.allocations.set(input.request_id, allocated);
          }
          result = allocated;
          if (state.dropGet) {
            state.dropGet = false;
            res.destroy();
          }
        }
      } else {
        const input = request.params
          .arguments as unknown as ReleaseAccountInput;
        state.releases.push(input);
        if (input.usage_stopped) state.released.add(input.lease_id);
        result = {
          schema_version: '1',
          status: input.usage_stopped ? 'released' : 'release_pending',
          lease_id: input.lease_id,
          released_at: input.usage_stopped ? new Date().toISOString() : null,
        };
        if (state.dropRelease && input.usage_stopped) {
          state.dropRelease = false;
          res.destroy();
        }
      }
      return {
        structuredContent: result,
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    });
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport as Parameters<Server['connect']>[0]);
    res.on('close', () => {
      void server.close();
    });
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  const config: DevPassConfig = {
    id: 'devpass',
    url: `http://127.0.0.1:${port}/mcp`,
    clientId: 'proofrun-fixture',
    tokenFile,
    privateKeyFiles: { 'key-1': privateFile },
    maxDurationSeconds: 7200,
    allowLoopback: true,
  };
  return {
    state,
    config,
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
