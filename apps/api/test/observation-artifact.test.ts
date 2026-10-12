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
