import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { authorizeCookieCleanup } from '../src/modules/scheduling/cookie-cleanup.js';
import type { ExecutionContext } from '../src/modules/scheduling/state.js';

// 范围：数据库端口夹具校验清理授权、精确名字与老节点能力；不验证实际 Cookie 存储。
test('Cookie 清理限定运行中的后续清理、原文名字和节点能力', async () => {
  const context = {
    task_id: 'fixture',
    node_id: 'node',
    definition: {
      cleanupStepIds: ['cleanup'],
      steps: [
        {
          stepId: 'cleanup',
          url: 'https://fixture.test/page',
          description: '清除 `NEXT_LOCALE` 和 jiekou_preferred_locale Cookie',
        },
      ],
    },
  } as unknown as ExecutionContext;
  let active = 'cleanup',
    supported = true;
  const client = {
    query: async (sql: string) => ({
      rows: sql.includes('step_results')
        ? [{ step_results: [{ stepId: active, status: 'RUNNING' }] }]
        : [{ capabilities: { cookieCleanup: supported } }],
    }),
  } as unknown as PoolClient;
  const command: Parameters<typeof authorizeCookieCleanup>[2] = {
    type: 'browser.cookies.clear' as const,
    url: 'https://fixture.test/page',
    names: ['NEXT_LOCALE'],
  };
  await authorizeCookieCleanup(client, context, command, 'AGENT');
  const patches: Partial<typeof command>[] = [
    { url: 'https://other.test' },
    { url: 'https://user@fixture.test' },
    { names: ['LOCALE'] },
    { names: ['session'] },
    { names: ['*'] },
  ];
  for (const patch of patches)
    await assert.rejects(
      authorizeCookieCleanup(
        client,
        context,
        { ...command, ...patch },
        'AGENT',
      ),
      { code: 'COOKIE_CLEANUP_FORBIDDEN' },
    );
  await assert.rejects(
    authorizeCookieCleanup(client, context, command, 'HUMAN'),
    { code: 'COOKIE_CLEANUP_FORBIDDEN' },
  );
  active = 'business';
  await assert.rejects(
    authorizeCookieCleanup(client, context, command, 'AGENT'),
    { code: 'COOKIE_CLEANUP_FORBIDDEN' },
  );
  active = 'cleanup';
  supported = false;
  await assert.rejects(
    authorizeCookieCleanup(client, context, command, 'AGENT'),
    { code: 'COOKIE_CLEANUP_UNSUPPORTED' },
  );
});
