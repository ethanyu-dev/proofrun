import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { HaApi } from './ha.js';

const config = loadConfig();
const ha = process.env.PROOFRUN_API_HA ?? 'false';
if (!['true', 'false'].includes(ha)) throw new Error('Invalid PROOFRUN_API_HA');
const app = ha === 'true' ? new HaApi(config) : await buildApp(config);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch((error: unknown) => {
      console.error(JSON.stringify({ event: 'api.shutdown_failed' }));
      process.exitCode = 1;
    });
  });
}
if (app instanceof HaApi) await app.listen();
else await app.listen({ host: config.host, port: config.port });
