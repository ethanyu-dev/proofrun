import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import type { RequestSummary, RequestResultV2 } from '@proofrun/contracts';
import { Database } from '../src/db.js';
import { RequestReader } from '../src/modules/requests/reader.js';
import {
  refreshRequestSummaries,
  rebuildRequestSummaries,
} from '../src/modules/requests/summary.js';

/** 合成任务只有三个标准，其中清理项不能影响业务判定；不执行模型或浏览器。 */
const DEFINITION = {
  taskId: 'fixture',
  objective: '含 %_\\ 的目标',
  steps: [{ stepId: 'business' }, { stepId: 'cleanup' }],
  cleanupStepIds: ['cleanup'],
  acceptanceCriteria: [
    { id: 'a', stepId: 'business', description: '甲', expectedResult: '甲' },
    { id: 'b', stepId: 'business', description: '乙', expectedResult: '乙' },
    {
      id: 'clean',
      stepId: 'cleanup',
      description: '清理',
      expectedResult: '清理',
    },
  ],
};
/** 报告保留重复标准与清理失败，验证汇总不会只依赖顶层 verdict。 */
function report(verdict = 'PASSED', duplicate = false) {
  return {
    executionDisposition: 'EXECUTED',
    verdict: 'FAILED',
    steps: [
      {
        stepId: 'business',
        status: 'COMPLETED',
        criteria: [],
        evidenceRefs: [],
        startedAt: null,
        finishedAt: null,
      },
      {
        stepId: 'cleanup',
        status: 'ERROR',
        criteria: [],
        evidenceRefs: [],
        startedAt: null,
        finishedAt: null,
      },
    ],
    criteria: [
      { criterionId: 'a', verdict },
      { criterionId: 'b', verdict },
      ...(duplicate ? [{ criterionId: 'a', verdict }] : []),
      { criterionId: 'clean', verdict: 'FAILED' },
    ],
    artifacts: [],
  };
}
/** 只去掉详情字段和快照时间；其余公开摘要字段必须逐项一致。 */
function summary(result: RequestResultV2 | RequestSummary) {
  const { generatedAt: _time, ...value } = result;
  if ('cases' in value) {
    const { cases: _cases, metrics: _metrics, ...rest } = value;
    return rest;
  }
  return value;
}

// 范围：真实 PostgreSQL 的触发器、迁移、回滚、快照与索引查询；不代表真实模型或生产性能验收。
test('请求摘要的一致性与可恢复刷新', { timeout: 60_000 }, async (suite) => {
  const address = process.env.PROOFRUN_TEST_DATABASE_URL;
  assert.ok(address, '需要独立测试 PostgreSQL');
  const admin = new pg.Client({ connectionString: address });
  await admin.connect();
  const name = `proofrun_summary_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(address);
  url.pathname = `/${name}`;
  let db = new Database(url.toString());
  await db.start();
  let reader = new RequestReader(db, 'http://localhost');
  const create = async (
    id: string,
    taskIds = [id],
    at = '2026-01-01T00:00:00.000001Z',
  ) => {
    await db.transaction(async (client) => {
      await client.query(
        `INSERT INTO pr_verification_requests(request_id,title,definition_hash,created_at) VALUES($1,$1,'fixture',$2)`,
        [id, at],
      );
      for (const task of taskIds)
        await client.query(
          `INSERT INTO pr_tasks(id,definition,definition_hash,state,deadline_at)
        VALUES($1,$2,'fixture','QUEUED',now()+interval '1 hour') ON CONFLICT DO NOTHING`,
          [task, DEFINITION],
        );
      for (const [i, task] of taskIds.entries())
        await client.query(
          `INSERT INTO pr_verification_request_cases(request_id,case_id,task_id,position,definition_hash,execution_origin)
           VALUES($1,$2,$3,$4,'fixture','created')`,
          [id, `${id}-${i}`, task, i],
        );
    });
  };
  const equal = async (id: string) => {
    const listing = await reader.list({ q: id });
    const value = listing.requests.find((r) => r.requestId === id);
    assert.ok(value);
    assert.deepEqual(summary(value), summary(await reader.get(id)));
    return value;
  };
  try {
    // 范围：共享任务、多 case 结果、缺报告、重复标准与清理隔离；报告是人为注入的事实。
    await suite.test(
      '所有状态变化与详情同口径，共享任务更新全部请求',
      async () => {
        await create('shared-one', ['shared-task', 'second-arm']);
        await create('shared-two', ['shared-task']);
        assert.equal((await equal('shared-one')).executionStatus, 'QUEUED');
        for (const state of [
          'RUNNING',
          'CANCELLED',
          'TIMED_OUT',
          'ERROR',
          'COMPLETED',
        ]) {
          await db.query('UPDATE pr_tasks SET state=$2 WHERE id=$1', [
            'shared-task',
            state,
          ]);
          await equal('shared-one');
          await equal('shared-two');
        }
        await db.query('UPDATE pr_tasks SET report=$2 WHERE id=$1', [
          'shared-task',
          report(),
        ]);
        assert.equal((await equal('shared-two')).reportStatus, 'PASSED');
        assert.equal((await equal('shared-one')).reportStatus, null);
        await db.query(
          "UPDATE pr_tasks SET state='COMPLETED',report=$2 WHERE id=$1",
          ['second-arm', report('FAILED')],
        );
        assert.equal(
          (await equal('shared-one')).uniqueCriteriaCounts.failed,
          2,
        );
        await db.query('UPDATE pr_tasks SET report=$2 WHERE id=$1', [
          'shared-task',
          report('PASSED', true),
        ]);
        assert.equal((await equal('shared-two')).reportStatus, 'INCONCLUSIVE');
        await db.query('UPDATE pr_tasks SET report=NULL WHERE id=$1', [
          'shared-task',
        ]);
        assert.equal((await equal('shared-two')).reportCoverage.missing, 1);
        await db.query(
          "UPDATE pr_tasks SET definition=jsonb_set(definition,'{acceptanceCriteria}','[]') WHERE id='shared-task'",
        );
        assert.equal((await equal('shared-two')).uniqueCriteriaCounts.total, 0);
      },
    );
    // 范围：事务回滚及无关心跳字段不造成重算；不模拟数据库磁盘故障。
    await suite.test('回滚不留下失效标记，无关更新不触发重算', async () => {
      await create('rollback');
      await equal('rollback');
      await assert.rejects(
        db.transaction(async (client) => {
          await client.query(
            "UPDATE pr_tasks SET state='ERROR' WHERE id='rollback'",
          );
          throw new Error('rollback fixture');
        }),
      );
      await db.query(
        "UPDATE pr_tasks SET deadline_at=now(),queue_reason=NULL WHERE id='rollback'",
      );
      assert.equal(
        (await db.query('SELECT count(*)::int n FROM pr_request_summary_dirty'))
          .rows[0]!.n,
        0,
      );
      assert.equal((await equal('rollback')).executionStatus, 'QUEUED');
    });
    // 范围：微秒游标、同时间次序、筛选和字面搜索；翻页期间不承诺跨 HTTP 请求固定快照。
    await suite.test('微秒分页不重不漏，搜索仍匹配完整成员', async () => {
      for (const [id, at] of [
        ['page-z', '000001'],
        ['page-a', '000002'],
        ['page-b', '000002'],
      ])
        await create(id!, undefined, `2026-01-01T00:00:00.${at}Z`);
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const result = await reader.list({
          q: 'page-',
          limit: '1',
          ...(cursor ? { cursor } : {}),
        });
        ids.push(...result.requests.map((r) => r.requestId));
        cursor = result.nextCursor;
      } while (cursor);
      assert.deepEqual(ids, ['page-b', 'page-a', 'page-z']);
      assert.equal(
        (await reader.list({ q: 'page-a\npage-a' })).requests.length,
        0,
      );
      assert.equal((await reader.list({ q: '%_\\' })).requests.length, 6);
      await db.query(
        "UPDATE pr_verification_requests SET title='更新后的唯一标题' WHERE request_id='page-a'",
      );
      assert.equal(
        (await reader.list({ q: '更新后的唯一标题' })).requests[0]?.requestId,
        'page-a',
      );
      await assert.rejects(
        reader.list({
          q: 'changed',
          cursor: Buffer.from(
            JSON.stringify({
              at: '2026-01-01T00:00:00.000001Z',
              id: 'page-z',
              filter: 'wrong',
            }),
          ).toString('base64url'),
        }),
      );
    });
    // 范围：确定发生在刷新持锁期间的并发任务更新；等待后必须保留新一代失效标记。
    await suite.test(
      '并发写入不能被刷新清除，旧快照不能覆盖新摘要',
      async () => {
        await create('racing');
        const client = await db.pool.connect();
        const writer = await db.pool.connect();
        try {
          const pid = (await writer.query('SELECT pg_backend_pid() AS pid'))
            .rows[0]!.pid;
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await refreshRequestSummaries(client);
          const changed = writer.query(
            "UPDATE pr_tasks SET state='ERROR' WHERE id='racing'",
          );
          // 等到 PostgreSQL 确认写入在等待标记锁，避免依靠时间猜测竞争已发生。
          let blocked = false;
          for (let n = 0; n < 80; n++) {
            blocked =
              (
                await db.query(
                  'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',
                  [pid],
                )
              ).rows[0]?.wait_event_type === 'Lock';
            if (blocked) break;
            await delay(25);
          }
          await client.query('COMMIT');
          await changed;
          assert.ok(blocked, '未命中预期锁竞争');
          assert.equal((await equal('racing')).executionStatus, 'FINISHED');
          await db.query(
            "UPDATE pr_tasks SET state='QUEUED' WHERE id='racing'",
          );
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          await client.query('SELECT * FROM pr_request_summary_dirty');
          await writer.query(
            "UPDATE pr_tasks SET state='RUNNING' WHERE id='racing'",
          );
          await assert.rejects(refreshRequestSummaries(client), {
            code: '40001',
          });
          await client.query('ROLLBACK');
        } finally {
          await client.query('ROLLBACK');
          client.release();
          writer.release();
        }
        await db.query("UPDATE pr_tasks SET state='RUNNING' WHERE id='racing'");
        const views = await Promise.all(
          Array.from({ length: 4 }, () => reader.list({ q: 'racing' })),
        );
        assert(
          views.every((v) => v.requests[0]?.executionStatus === 'IN_PROGRESS'),
        );
      },
    );
    // 范围：分批重建、归属删除、启动恢复；不验证生产备份恢复过程。
    await suite.test('摘要可重建，启动继续未完成批次', async () => {
      await db.query(
        "DELETE FROM pr_verification_request_cases WHERE request_id='shared-one' AND task_id='second-arm'",
      );
      assert.equal((await equal('shared-one')).executionCounts.total, 1);
      await db.query('DELETE FROM pr_request_summaries');
      for (let i = 0; i < 101; i++) await create(`backfill-${i}`);
      await db.query(
        'INSERT INTO pr_request_summary_dirty(request_id) SELECT request_id FROM pr_verification_requests ON CONFLICT DO NOTHING',
      );
      assert.equal(
        await db.transaction(async (client) => {
          await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
          return refreshRequestSummaries(client, 1);
        }),
        100,
      );
      assert(
        (await db.query('SELECT count(*)::int n FROM pr_request_summary_dirty'))
          .rows[0]!.n > 0,
      );
      await db.close();
      db = new Database(url.toString());
      await db.start();
      reader = new RequestReader(db, 'http://localhost');
      assert.equal(
        (await db.query('SELECT count(*)::int n FROM pr_request_summary_dirty'))
          .rows[0]!.n,
        0,
      );
      for (const id of [
        'shared-one',
        'shared-two',
        'rollback',
        'racing',
        'page-a',
      ])
        await equal(id);
      await db.query(
        "UPDATE pr_request_summaries SET summary=jsonb_set(summary,'{caseCount}','999') WHERE request_id='rollback'",
      );
      assert.equal(await rebuildRequestSummaries(db), 108);
      assert.equal((await equal('rollback')).caseCount, 1);
    });
  } finally {
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
