import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

/** 仅开发服务器读取代理地址；管理员凭据始终由当前页面发送，不能在此注入。 */
const apiTarget = process.env.PROOFRUN_API_PROXY ?? 'http://127.0.0.1:4100';
export default defineConfig({
  server: {
    // 本地双画面预览可选 TLS；证书留在忽略目录，不把私钥打进前端构建。
    ...(process.env.PROOFRUN_TLS_CERT && process.env.PROOFRUN_TLS_KEY
      ? {
          https: {
            cert: readFileSync(process.env.PROOFRUN_TLS_CERT),
            key: readFileSync(process.env.PROOFRUN_TLS_KEY),
          },
        }
      : {}),
    proxy: {
      '/v1': { target: apiTarget, ws: true },
      '/v2': { target: apiTarget },
      '/health': { target: apiTarget },
    },
  },
});
