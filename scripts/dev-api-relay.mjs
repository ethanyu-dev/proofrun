import { readFileSync } from 'node:fs';
import { createServer } from 'node:tls';
import { connect } from 'node:net';

/** 只在本机开发时连接 Docker 节点；跨 Docker 边界的流量使用固定证书校验。 */
const [certificate, privateKey, listenPort, apiPort] = process.argv.slice(2);
const server = createServer(
  { cert: readFileSync(certificate), key: readFileSync(privateKey) },
  (client) => {
    const upstream = connect(Number(apiPort), '127.0.0.1');
    client.pipe(upstream).pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  },
);
server.on('tlsClientError', () => {});
server.listen(Number(listenPort), '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => server.close(() => process.exit(0)));
