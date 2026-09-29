import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import Fastify from 'fastify';
import { registerPublicDocs } from '../src/modules/docs/routes.js';

// 范围：真实文档路由复用打包规范，保留业务认证声明；不连接数据库或调用生产 API。
test('公开规范与共享契约一致，并将在线调试限制到当前来源', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  registerPublicDocs(app);
  const response = await app.inject('/openapi.json');
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type']!, /application\/json/);
  const document = response.json();
  const require = createRequire(import.meta.url);
  const generated = JSON.parse(
    readFileSync(
      require.resolve('@proofrun/contracts/public-api.openapi.json'),
      'utf8',
    ),
  );
  assert.deepEqual(document, {
    ...generated,
    servers: [{ url: '/', description: '当前访问入口（同源）' }],
  });
  assert.deepEqual(document.security, [{ AdminBearer: [] }]);
  assert.ok(document.paths['/v2/cases']);
  assert.ok(document.paths['/v1/cases']);
  assert.equal(document.paths['/v1/nodes'], undefined);
});

// 范围：文档重定向、同源资源、CSP 和调试配置；不把注入测试视为浏览器渲染或 TLS 验收。
test('文档资源可匿名读取，但不提供第三方脚本、预置凭据或任意文件读取', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  registerPublicDocs(app);
  const redirect = await app.inject('/docs');
  assert.equal(redirect.statusCode, 308);
  assert.equal(redirect.headers.location, '/docs/');
  const page = await app.inject('/docs/');
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type']!, /text\/html/);
  assert.match(
    page.headers['content-security-policy'] as string,
    /script-src 'self';/,
  );
  assert.match(
    page.headers['content-security-policy'] as string,
    /connect-src 'self';/,
  );
  const assets = [...page.body.matchAll(/(?:src|href)="(\/docs\/[^" ]+)"/g)];
  assert.equal(assets.length, 3);
  for (const [, path] of assets) {
    const asset = await app.inject(path!);
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.headers['x-content-type-options'], 'nosniff');
    assert.match(
      asset.headers['content-type']!,
      path!.endsWith('.css') ? /text\/css/ : /text\/javascript/,
    );
    assert.ok(asset.body.length > 100);
  }
  const initializer = (await app.inject('/docs/init.js')).body;
  assert.match(initializer, /persistAuthorization: false/);
  assert.match(initializer, /validatorUrl: null/);
  assert.match(initializer, /queryConfigEnabled: false/);
  assert.equal((await app.inject('/docs/package.json')).statusCode, 404);
});
