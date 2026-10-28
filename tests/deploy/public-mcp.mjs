import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';

/** 发布路径测试使用同源 Host，避免临时 Docker 映射端口改变生产 Host 授权规则。 */
export const PUBLIC_ORIGIN = 'http://proofrun.example.test';

/** Node fetch 不保留自定义 Host；原生 HTTP 将测试 origin 送到代理，保持真实服务端 Host 门禁。 */
async function readJson(url, { headers, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers, method, timeout: 20_000 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (part) => {
        text += part;
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          assert.match(res.headers['content-type'] ?? '', /application\/json/);
          resolve({ status: res.statusCode, data: JSON.parse(text) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('部署接入检查超时')));
    req.end(body);
  });
}

/** 临时令牌只授予发现与只读权限，不提交任务或启动浏览器。 */
export function publicCredentials(token) {
  return [
    {
      principalId: 'deployment-fixture',
      tokenSha256: createHash('sha256').update(token).digest('hex'),
      channels: ['browser', 'verification'],
      scopes: ['runs:read'],
    },
  ];
}

/** 范围：通过真实代理完成认证、HTTP 能力读取和 MCP 握手/工具发现；不验收业务浏览器或模型。 */
export async function checkPublicMcp(base, token) {
  const host = new URL(PUBLIC_ORIGIN).host;
  for (const channel of ['browser', 'verification']) {
    for (const path of [`/mcp/${channel}`, `/v3/${channel}/capabilities`]) {
      const denied = await readJson(base + path, { headers: { host } });
      assert.equal(
        denied.status,
        401,
        `${path} 必须进入 API 鉴权，不能回退 Console`,
      );
      assert.equal(denied.data.code, 'UNAUTHORIZED');
    }
    const headers = { host, authorization: `Bearer ${token}` };
    const response = await readJson(`${base}/v3/${channel}/capabilities`, {
      headers,
    });
    assert.equal(response.status, 200);
    assert.equal(response.data.kind, 'capabilities');
    // 镜像 CI 的宿主没有 workspace 依赖；用原生 HTTP 检查真实 JSON-RPC，SDK 兼容另有集成测试。
    const rpc = async (id, method, params) => {
      const result = await readJson(`${base}/mcp/${channel}`, {
        method: 'POST',
        headers: {
          ...headers,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-03-26',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      assert.equal(result.status, 200);
      const data = result.data;
      assert.equal(data.error, undefined, JSON.stringify(data));
      return data.result;
    };
    const initialized = await rpc(1, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'deployment-regression', version: '1.0.0' },
    });
    assert.equal(initialized.serverInfo.name, `proofrun-${channel}`);
    const { tools } = await rpc(2, 'tools/list', {});
    assert(tools.some((tool) => tool.name === `${channel}_get_capabilities`));
    assert(tools.every((tool) => tool.name.startsWith(`${channel}_`)));
  }
}
