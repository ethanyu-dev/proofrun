import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiConfig } from '../src/config.js';
import type { Database } from '../src/db.js';
import type { Coordinator } from '../src/modules/scheduling/coordinator.js';
import type { ExternalEngine } from '../src/modules/external-execution/engine.js';
import { ExternalExecution } from '../src/modules/external-execution/service.js';

/** 固定扫描与加锁之间的续期顺序；仅模拟数据库返回，不替代真实数据库和浏览器集成测试。 */
function supervisor(renewed: boolean) {
  const scanned = {
    id: 'controller',
    run_id: 'run',
    principal_id: 'principal',
    state: 'ACTIVE',
    execution_id: renewed ? 'execution' : null,
    control_revision: '1',
    auth_revision: '1',
    idle_deadline_at: new Date(0),
  };
  const locked = {
    ...scanned,
    idle_deadline_at: renewed ? new Date(Date.now() + 60_000) : new Date(0),
  };
  const calls = { abort: 0, heartbeat: 0, cancel: 0, expire: 0, claim: 0 };
  const query = async (sql: string) => {
    if (sql.includes("WHERE state='ACTIVE' ORDER BY created_at"))
      return { rows: [scanned], rowCount: 1 };
    if (sql.startsWith('SELECT * FROM pr_external_controllers'))
      return { rows: [locked], rowCount: 1 };
    if (sql.startsWith('SELECT state FROM pr_tasks'))
      return { rows: [{ state: renewed ? 'RUNNING' : 'QUEUED' }], rowCount: 1 };
    if (sql.includes('FROM pr_executions e JOIN pr_tasks'))
      return { rows: [{ task_state: 'RUNNING' }], rowCount: 1 };
    if (sql.includes("SET state='EXPIRED'")) calls.expire++;
    return { rows: [{}], rowCount: 1 };
  };
  const db = {
    query,
    transaction: (fn: (client: { query: typeof query }) => Promise<unknown>) =>
      fn({ query }),
  } as unknown as Database;
  const coordinator = {
    execution: async () => ({
      controlMode: 'AUTO',
      controlRevision: 1,
      authRevision: 1,
    }),
    heartbeatExecution: async () => {
      calls.heartbeat++;
    },
    cancelInTransaction: async () => {
      calls.cancel++;
    },
    claim: async () => {
      calls.claim++;
      return {};
    },
  } as unknown as Coordinator;
  const engine = {
    grant: () => (renewed ? { id: 'execution', leaseToken: 'fixture' } : null),
    waiting: () => true,
    abort: () => {
      calls.abort++;
    },
  } as unknown as ExternalEngine;
  return {
    service: new ExternalExecution(db, coordinator, engine, {} as ApiConfig),
    calls,
  };
}

// 范围：旧扫描遇到已续期控制行必须保留执行并继续心跳；不验证真实并发锁或物理浏览器。
test('外部控制器扫描过期快照后，持锁发现续期不能撤销执行', async () => {
  const { service, calls } = supervisor(true);
  await service.tick();
  assert.deepEqual(calls, {
    abort: 0,
    heartbeat: 1,
    cancel: 0,
    expire: 0,
    claim: 0,
  });
});

// 范围：持锁后仍过期的排队绑定必须提交过期并撤销；不验证已启动会话的物理清理。
test('外部控制器真正过期时仍取消任务且不重新领取', async () => {
  const { service, calls } = supervisor(false);
  await service.tick();
  assert.deepEqual(calls, {
    abort: 1,
    heartbeat: 0,
    cancel: 1,
    expire: 1,
    claim: 0,
  });
});
