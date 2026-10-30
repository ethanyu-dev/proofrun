import assert from 'node:assert/strict';

/** 部署夹具的公开来源，仅用于隔离容器，不连接线上服务。 */
export const PUBLIC_ORIGIN = 'http://proofrun.example.test';

/** 范围：真实代理对退役入口返回 404，不回退 Console；不验证模型、浏览器或线上部署。 */
export async function checkRetiredApi(base) {
  for (const path of [
    '/mcp/browser',
    '/mcp/verification',
    '/v3/browser/capabilities',
    '/v3/verification/requests',
  ]) {
    for (const method of ['GET', 'POST']) {
      const response = await fetch(base + path, {
        method,
        signal: AbortSignal.timeout(20000),
      });
      assert.equal(response.status, 404, `${method} ${path} 应已退役`);
      assert.doesNotMatch(await response.text(), /<!doctype html/i);
    }
  }
}
