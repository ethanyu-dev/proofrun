import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../apps/api/src/app.ts';
import {
  SimulatedNode,
  PNG,
  PNG_HASH,
  task,
  until,
} from '../../apps/api/test/fixture.ts';

/** 仅临时数据库、回环接口和浏览器联调使用，不能复用为部署凭据。 */
const ADMIN = 'proofrun-console-local-fixture-admin';
const WORKER = 'proofrun-console-local-fixture-worker';
const PORT = Number(process.env.PROOFRUN_CONSOLE_FIXTURE_PORT ?? 4100);
const BASE = `http://127.0.0.1:${PORT}`;
const require = createRequire(
  new URL('../../apps/api/package.json', import.meta.url),
);
const { Pool } = require('pg');
const databaseUrl = process.env.PROOFRUN_TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error('需要独立测试数据库 PROOFRUN_TEST_DATABASE_URL');
const adminDb = new Pool({ connectionString: databaseUrl });
const name = `console_fixture_${randomUUID().replaceAll('-', '')}`;
const root = await mkdtemp(join(tmpdir(), 'proofrun-console-'));
await adminDb.query(`CREATE DATABASE ${name}`);
const url = new URL(databaseUrl);
url.pathname = `/${name}`;
let app;
let node;
let humanTimer;

/** 全部写入走真实 API；节点和 PNG 为协议夹具，不代表真实浏览器或模型验收。 */
async function api(method, path, body, token = ADMIN) {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

/** 退出时只回收本脚本创建的数据库、节点连接和临时证据。 */
async function cleanup() {
  clearInterval(humanTimer);
  node?.close();
  await app?.close();
  await adminDb.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await adminDb.end();
  await rm(root, { recursive: true, force: true });
}
try {
  app = await buildApp(
    {
      databaseUrl: url.toString(),
      adminToken: ADMIN,
      workerToken: WORKER,
      publicUrl: BASE,
      artifactDirectory: root,
      host: '127.0.0.1',
      port: PORT,
      workerLeaseMs: 15000,
      nodeLeaseMs: 15000,
      tickMs: 100,
    },
    { logger: false },
  );
  await app.listen({ host: '127.0.0.1', port: PORT });
  node = new SimulatedNode(BASE, 'console-fixture', 2);
  await node.pair(ADMIN);
  await until(
    () => api('GET', '/v1/nodes'),
    (value) => value.nodes.some((item) => item.online),
  );
  for (const disposition of ['EXECUTED', 'BLOCKED', 'ERROR']) {
    const id = `console-${disposition.toLowerCase()}`;
    const definition = {
      ...task('console-fixture', disposition === 'EXECUTED'),
      taskId: id,
      objective: `[联调夹具] ${disposition === 'EXECUTED' ? '表单提交验收' : disposition === 'BLOCKED' ? '目标环境受阻' : '执行服务异常'}`,
    };
    await api('POST', '/v1/tasks', definition);
    const { execution } = await api(
      'POST',
      '/v1/worker/claim',
      { type: 'worker.claim', workerId: 'console-fixture-worker' },
      WORKER,
    );
    await until(
      () =>
        api(
          'GET',
          `/v1/executions/${execution.id}`,
          undefined,
          execution.leaseToken,
        ),
      (value) => value.state === 'RUNNING',
    );
    let refs = [];
    if (disposition === 'EXECUTED') {
      const commandId = randomUUID();
      await api(
        'POST',
        `/v1/executions/${execution.id}/commands`,
        {
          type: 'execution.command',
          commandId,
          timeoutMs: 5000,
          command: { type: 'browser.observe', screenshot: true },
        },
        execution.leaseToken,
      );
      const output = await until(
        () =>
          api(
            'GET',
            `/v1/executions/${execution.id}/commands/${commandId}`,
            undefined,
            execution.leaseToken,
          ),
        (value) => !!value.result,
      );
      refs = output.result.data.artifactRefs;
      const screenshot = refs.find((item) => item.kind === 'SCREENSHOT');
      const uploaded = await fetch(
        `${BASE}/v1/artifacts/${screenshot.artifactId}`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${node.token}`,
            'content-type': 'image/png',
            'x-content-sha256': PNG_HASH,
          },
          body: PNG,
        },
      );
      if (!uploaded.ok) throw new Error('截图夹具上传失败');
      node.send({
        type: 'artifact.available',
        messageId: `artifact:${screenshot.artifactId}`,
        artifactId: screenshot.artifactId,
        sha256: PNG_HASH,
      });
      await until(
        () =>
          api(
            'GET',
            `/v1/executions/${execution.id}`,
            undefined,
            execution.leaseToken,
          ),
        (value) => value.artifacts.every((item) => item.state === 'AVAILABLE'),
      );
    }
    const report = {
      protocolVersion: '0.1',
      taskId: id,
      lifecycle: 'COMPLETED',
      executionDisposition: disposition,
      verdict: disposition === 'EXECUTED' ? 'PASSED' : null,
      summary: '控制台协议联调夹具，不代表真实业务验收。',
      criteria: [
        {
          criterionId: 'visible',
          verdict: disposition === 'EXECUTED' ? 'PASSED' : 'SKIPPED',
          summary:
            disposition === 'EXECUTED'
              ? '模拟页面已采集 DOM 和 PNG。'
              : '未完成执行，不给出产品结论。',
          evidenceRefs: refs.map((ref) => ref.artifactId),
        },
      ],
      artifacts: refs.map((ref) => ({
        id: ref.artifactId,
        kind: ref.kind,
        sha256: ref.sha256,
        uri: 'https://ignored.invalid/evidence',
      })),
    };
    await api(
      'POST',
      `/v1/executions/${execution.id}/complete`,
      { type: 'execution.complete', report },
      execution.leaseToken,
    );
    await until(
      () => api('GET', `/v1/tasks/${id}`),
      (value) => value.executions.every((item) => item.closure_verified),
    );
  }
  // 人工交接页面夹具：模拟 worker 的续租与安全点确认，模型行为另由集成测试验证。
  await api('POST', '/v1/tasks', {
    ...task('console-fixture'),
    taskId: 'console-human',
    objective: '[联调夹具] 人工介入和恢复',
    environment: {
      id: 'fixture',
      nodePool: 'console-fixture',
      allowIntervention: true,
    },
    budget: { timeoutMs: 3600000, maxActions: 20 },
  });
  const { execution: human } = await api(
    'POST',
    '/v1/worker/claim',
    { type: 'worker.claim', workerId: 'console-human-fixture' },
    WORKER,
  );
  await until(
    () => api('GET', `/v1/executions/${human.id}`, undefined, human.leaseToken),
    (view) => view.state === 'RUNNING',
  );
  let renewing = false;
  humanTimer = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      const view = await api(
        'GET',
        `/v1/executions/${human.id}`,
        undefined,
        human.leaseToken,
      );
      if (view.taskState !== 'RUNNING') {
        clearInterval(humanTimer);
        return;
      }
      await api(
        'POST',
        `/v1/executions/${human.id}/heartbeat`,
        undefined,
        human.leaseToken,
      );
      if (view.controlMode === 'REQUESTED')
        await api(
          'POST',
          `/v1/executions/${human.id}/control`,
          {
            type: 'execution.control',
            action: 'acknowledge',
            controlRevision: view.controlRevision,
          },
          human.leaseToken,
        );
    } catch {
      clearInterval(humanTimer);
    } finally {
      renewing = false;
    }
  }, 1000);
  for (let i = 1; i <= 28; i++)
    await api('POST', '/v1/tasks', {
      ...task('no-node-fixture'),
      taskId: `console-queued-${String(i).padStart(2, '0')}`,
      objective: `[联调夹具] 排队任务 ${String(i).padStart(2, '0')}`,
      budget: { timeoutMs: 3600000, maxActions: 20 },
    });
  console.log(
    '控制台夹具就绪：API 127.0.0.1:4100；访问凭据见本文件 ADMIN 常量。',
  );
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
} finally {
  await cleanup();
}
