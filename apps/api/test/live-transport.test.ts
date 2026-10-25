import assert from 'node:assert/strict';
import test from 'node:test';
import type { Database } from '../src/db.js';
import { LiveService } from '../src/modules/hitl/live.js';

// 范围：只读凭证绑定节点地址和 Origin，控制面不接收媒体；数据库为夹具，不验证真实浏览器或 TLS。
test('只读观看安装会话凭证后返回节点直连地址', async () => {
  let installed: any;
  const context = {
    id: 'execution',
    task_id: 'task',
    node_id: 'node',
    node_epoch: 'epoch',
    session_id: 'session',
    lease_id: 'lease',
    fence: '1',
    task_state: 'RUNNING',
    execution_state: 'RUNNING',
    session_state: 'ACTIVE',
    control_mode: 'AUTO',
    control_revision: 2,
    auth_revision: 3,
    lease_expires_at: new Date(Date.now() + 60_000),
    deadline_at: new Date(Date.now() + 600_000),
  };
  const query = async (sql: string, values?: unknown[]) => {
    if (sql.includes('FROM pr_executions')) return { rows: [context] };
    if (sql.includes('FROM pr_nodes'))
      return {
        rows: [
          {
            public_url: 'https://node.example.test',
            capabilities: { directHitl: true },
          },
        ],
      };
    if (sql.startsWith('INSERT INTO pr_commands')) {
      installed = values![6];
      return { rows: [] };
    }
    if (sql.includes('SELECT result'))
      return { rows: [{ result: { operationStatus: 'SUCCEEDED' } }] };
    throw new Error(sql);
  };
  const db = {
    query,
    transaction: (f: any) => f({ query }),
  } as unknown as Database;
  const result = await new LiveService(
    db,
    'https://console.example.test',
  ).bootstrap('execution');
  assert.equal(result.waiting, false);
  assert.equal(result.url, 'wss://node.example.test/live/frames');
  assert.equal(installed.command.type, 'session.watch');
  assert.equal(installed.command.revision, 2);
  assert.equal(installed.command.grant.origin, 'https://console.example.test');
  assert.notEqual(installed.command.grant.tokenHash, result.token);
  assert.equal(installed.sessionId, 'session');
  context.control_mode = 'HUMAN';
  await assert.rejects(
    new LiveService(db, 'https://console.example.test').bootstrap('execution'),
    /画面已交给人工/,
  );
});
