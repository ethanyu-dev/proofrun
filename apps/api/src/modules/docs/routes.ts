import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';

/** 只从已锁定的生产依赖读取固定资源，不接受请求提供的文件路径。 */
const require = createRequire(import.meta.url);
const ASSETS = {
  'swagger-ui.css': 'text/css; charset=utf-8',
  'swagger-ui-bundle.js': 'text/javascript; charset=utf-8',
} as const;
/** 文档和凭据均留在当前来源；禁用第三方脚本、校验服务和嵌入页面。 */
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ProofRun HTTP API</title>
  <link rel="stylesheet" href="/docs/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/docs/swagger-ui-bundle.js" defer></script>
  <script src="/docs/init.js" defer></script>
</body>
</html>`;
/** 用户主动授权后才可调试；不预置令牌，不持久化授权，不允许 URL 参数替换规范。 */
const INITIALIZER = `SwaggerUIBundle({
  url: '/openapi.json',
  dom_id: '#swagger-ui',
  deepLinking: true,
  docExpansion: 'list',
  defaultModelsExpandDepth: -1,
  persistAuthorization: false,
  queryConfigEnabled: false,
  validatorUrl: null,
  withCredentials: false,
  presets: [SwaggerUIBundle.presets.apis],
  layout: 'BaseLayout'
});`;

/** 注册公开说明页；业务接口仍由原路由执行 Bearer 鉴权，文档不包含部署配置。 */
export function registerPublicDocs(app: FastifyInstance): void {
  const document = JSON.parse(
    readFileSync(
      require.resolve('@proofrun/contracts/public-api.openapi.json'),
      'utf8',
    ),
  );
  // 浏览器调试固定同源，避免 API 与 Console 域名不同造成跨域或凭据发送到其他来源。
  document.servers = [{ url: '/', description: '当前访问入口（同源）' }];
  app.get('/openapi.json', (_request, reply) =>
    reply
      .header('Cache-Control', 'no-cache')
      .header('X-Content-Type-Options', 'nosniff')
      .send(document),
  );
  app.get('/docs', (_request, reply) => reply.redirect('/docs/', 308));
  app.get('/docs/', (_request, reply) =>
    reply
      .header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
      .header('Cache-Control', 'no-cache')
      .header('X-Content-Type-Options', 'nosniff')
      .type('text/html; charset=utf-8')
      .send(PAGE),
  );
  app.get('/docs/init.js', (_request, reply) =>
    reply
      .header('Cache-Control', 'no-cache')
      .header('X-Content-Type-Options', 'nosniff')
      .type('text/javascript; charset=utf-8')
      .send(INITIALIZER),
  );
  for (const [name, contentType] of Object.entries(ASSETS)) {
    const content = readFileSync(require.resolve(`swagger-ui-dist/${name}`));
    app.get(`/docs/${name}`, (_request, reply) =>
      reply
        .header('Cache-Control', 'public, max-age=3600')
        .header('X-Content-Type-Options', 'nosniff')
        .type(contentType)
        .send(content),
    );
  }
}
