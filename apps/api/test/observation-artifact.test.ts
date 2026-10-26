import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { ArtifactStore } from '../src/modules/reports/artifacts.js';
import { canonical, digest, type CommandResult } from '../src/domain.js';
import type { Database } from '../src/db.js';
import type { ExecutionContext } from '../src/modules/scheduling/state.js';

// 范围：以数据库端口夹具验证文档声明、观察诊断与摘要归档；不证明真实 PostgreSQL 事务或文件上传。
test('DOM 证据保留采集缺口和原始语义快照，并参与摘要计算', async () => {
  let stored: unknown[] = [];
  const client = {
    async query(_sql: string, args: unknown[]) {
      stored = args;
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  const store = new ArtifactStore(
    {} as Database,
    '/unused',
    'http://localhost',
  );
  const result = {
    commandId: 'fixture-command',
    operationStatus: 'SUCCEEDED',
    data: {
      observationId: 'fixture-observation',
      text: '当前 DOM',
      targets: [],
      documents: [
        {
          frameId: 'main',
          url: 'https://fixture.invalid/',
          lang: 'zh-CN',
          isMainFrame: true,
        },
      ],
      coverage: {
        controls: {
          inspectionErrors: 1,
          excludedReasons: { outside_viewport: 2 },
        },
      },
      referenceSnapshot: {
        source: 'agent-browser',
        text: '原始语义快照',
        truncated: false,
        refCount: 3,
      },
    },
  } as unknown as CommandResult;
  const context = {
    node_id: 'fixture-node',
    id: 'fixture-execution',
    session_id: 'fixture-session',
  } as ExecutionContext;
  const output = await store.register(client, context, result, true);
  const content = stored[7] as Record<string, unknown>;
  assert.deepEqual(content.coverage, result.data!.coverage);
  assert.deepEqual(content.documents, result.data!.documents);
  assert.deepEqual(content.referenceSnapshot, result.data!.referenceSnapshot);
  assert.equal(stored[5], digest(canonical(content)));
  assert.equal(
    (output.data!.artifactRefs as Array<{ sha256: string }>)[0]!.sha256,
    stored[5],
  );
  assert.equal(result.data!.artifactRefs, undefined);
});

// 范围：运行时证据独立归档、摘要与类型归属；不代替真实 Chrome 取证。
test('RUNTIME 归档保留真实状态并与 DOM 分开引用', async () => {
  const stored: Array<{ sql: string; args: unknown[] }> = [];
  const client = {
    async query(sql: string, args: unknown[]) {
      stored.push({ sql, args });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  const store = new ArtifactStore(
    {} as Database,
    '/unused',
    'http://localhost',
  );
  const runtime = {
    version: 1,
    status: 'observed',
    serviceWorker: { registrations: [] },
    cacheStorage: { status: 'unavailable', reason: 'CACHE_READ_FAILED' },
  };
  const result = {
    commandId: 'fixture',
    operationStatus: 'SUCCEEDED',
    data: { observationId: 'o', text: 'page', targets: [], runtime },
  } as unknown as CommandResult;
  const context = {
    node_id: 'n',
    id: 'e',
    session_id: 's',
  } as ExecutionContext;
  const out = await store.register(client, context, result, true);
  const record = stored.find((row) => row.sql.includes("'RUNTIME'"))!;
  assert.deepEqual(record.args[7], runtime);
  assert.equal(record.args[5], digest(canonical(runtime)));
  assert.deepEqual(
    (out.data!.artifactRefs as Array<{ kind: string }>).map((r) => r.kind),
    ['DOM', 'RUNTIME'],
  );
});

// 范围：报告门禁读取已存档 RUNTIME，拒绝用 DOM 或未激活注册宣称准备完成；不运行浏览器。
test('SW 准备完成必须引用同执行已激活注册证据', async () => {
  let runtime: unknown = {
    status: 'observed',
    origin: 'https://site.test',
    serviceWorker: { registrations: [] },
  };
  const client = {
    async query(sql: string) {
      return {
        rows: sql.includes('step_results')
          ? [{ step_results: null }]
          : [
              { id: 'dom', kind: 'DOM' },
              { id: 'runtime', kind: 'RUNTIME', runtime_content: runtime },
            ],
      };
    },
  } as unknown as PoolClient;
  const store = new ArtifactStore(
    {} as Database,
    '/unused',
    'http://localhost',
  );
  const context = {
    id: 'e',
    task_id: 't',
    definition: {
      steps: [
        {
          stepId: 's',
          type: 'setup',
          description: '等待 Service Worker 安装并激活',
          url: 'https://site.test/novi',
          policy: [],
          expected: [],
        },
      ],
      acceptanceCriteria: [],
      executionPlan: { requiredCapabilities: ['runtimeEvidenceV1'] },
    },
  } as unknown as ExecutionContext;
  const steps: import('@proofrun/contracts').StepResult[] = [
    {
      stepId: 's',
      status: 'COMPLETED',
      summary: '准备完成',
      criteria: [],
      evidenceRefs: ['dom'],
      startedAt: '2026-10-26T00:00:00Z',
      finishedAt: '2026-10-26T00:00:01Z',
    },
  ];
  await assert.rejects(store.validateSteps(client, context, steps), {
    code: 'INVALID_STEPS',
  });
  steps[0]!.evidenceRefs.push('runtime');
  await assert.rejects(store.validateSteps(client, context, steps), {
    code: 'INVALID_STEPS',
  });
  runtime = {
    status: 'observed',
    origin: 'https://site.test',
    serviceWorker: {
      registrations: [
        { scope: 'https://site.test/', active: { state: 'activated' } },
      ],
    },
  };
  await store.validateSteps(client, context, steps);
});
