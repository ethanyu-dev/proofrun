import assert from 'node:assert/strict';
import test from 'node:test';
import type { Database } from '../src/db.js';
import { executionTimeline } from '../src/modules/scheduling/timeline.js';

// 范围：完整历史的页界与执行隔离，数据库端口为夹具；真实 SQL 另由本地历史记录验证。
test('操作时间线保留第 201 条作为下一页，不静默截断历史', async () => {
  const db = {
    query: async (sql: string, args: unknown[]) => {
      if (sql === 'SELECT id FROM pr_executions WHERE id=$1')
        return { rowCount: 1, rows: [{ id: 'exec' }] };
      assert.match(sql, /c\.execution_id=\$1/);
      assert.match(sql, /a\.command_id=c\.id/);
      assert.match(sql, /ORDER BY c.created_at,c.id LIMIT \$3/);
      assert.deepEqual(args, ['exec', null, 201]);
      return {
        rows: Array.from({ length: 201 }, (_, i) => ({ id: `command-${i}` })),
      };
    },
  } as unknown as Database;
  const page = await executionTimeline(db, 'exec');
  assert.equal(page.commands.length, 200);
  assert.equal(page.nextCursor, 'command-199');
});

// 范围：缺失执行或跨执行游标拒绝；不覆盖路由认证或真实数据库隔离级别。
test('时间线拒绝不存在的执行和不属于它的游标', async () => {
  const missing = {
    query: async () => ({ rowCount: 0, rows: [] }),
  } as unknown as Database;
  await assert.rejects(executionTimeline(missing, 'missing'), {
    code: 'EXECUTION_MISSING',
  });
  const db = {
    query: async (sql: string) => ({
      rowCount: sql.includes('pr_executions') ? 1 : 0,
      rows: [],
    }),
  } as unknown as Database;
  await assert.rejects(executionTimeline(db, 'exec', 'another-command'), {
    code: 'INVALID_CURSOR',
  });
});
