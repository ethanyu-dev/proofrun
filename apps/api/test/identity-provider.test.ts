import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HttpCatalogProvider,
  providerUrl,
} from '../src/modules/identities/provider.js';

// 范围：真实回环 HTTP、凭据头、元数据缓存、刷新失败和敏感字段拒绝；不访问外部生产身份库。
test('外部身份库失败时不复用过期元数据，响应不能携带秘密', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proofrun-provider-'));
  const file = join(dir, 'token');
  await writeFile(file, 'fixture-provider-token', { mode: 0o600 });
  let calls = 0;
  let mode = 'valid';
  const server = createServer((request, response) => {
    calls++;
    assert.equal(
      request.headers.authorization,
      'Bearer fixture-provider-token',
    );
    response.setHeader('Content-Type', 'application/json');
    if (mode === 'redirect') {
      response.writeHead(302, { Location: '/other' }).end();
      return;
    }
    if (mode === 'failed') {
      response.writeHead(503).end('fixture-private-provider-response');
      return;
    }
    response.end(
      JSON.stringify({
        identities: [],
        pools: [],
        sites: [],
        ...(mode === 'secret' ? { password: 'fixture-private-password' } : {}),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const provider = new HttpCatalogProvider({
    url: `http://127.0.0.1:${address.port}/catalog`,
    tokenFile: file,
  });
  try {
    assert.equal(
      providerUrl('https://identities.example.test/catalog'),
      'https://identities.example.test/catalog',
    );
    assert.throws(() => providerUrl('http://identities.example.test/catalog'));
    assert.throws(() =>
      providerUrl('https://user:secret@identities.example.test/catalog'),
    );
    await Promise.all([provider.get(), provider.get()]);
    assert.equal(calls, 1);
    mode = 'failed';
    await assert.rejects(provider.get(true), {
      code: 'IDENTITY_PROVIDER_UNAVAILABLE',
    });
    await assert.rejects(provider.get(), {
      code: 'IDENTITY_PROVIDER_UNAVAILABLE',
    });
    assert.equal(calls, 3);
    mode = 'secret';
    await assert.rejects(
      provider.get(),
      (error) => !String(error).includes('fixture-private-password'),
    );
    mode = 'redirect';
    await assert.rejects(provider.get(), {
      code: 'IDENTITY_PROVIDER_UNAVAILABLE',
    });
    mode = 'valid';
    assert.deepEqual(await provider.get(), {
      identities: [],
      pools: [],
      sites: [],
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
