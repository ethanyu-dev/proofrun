import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { authorizePreparation } from '../src/modules/identities/preparation.js';
import type { ExecutionContext } from '../src/modules/scheduling/state.js';
import { sessionBudgetMs, compileStepBudget } from '@proofrun/contracts';
import { task } from './fixture.js';

// 范围：绑定实际分配结果、不能更换配方或条件、准备不可重复；查询为夹具，不证明数据库锁并发。
test('登录准备绑定已分配身份且独立于业务步骤', async () => {
  const identity = {
    id: 'member',
    loginRef: 'private',
    checks: [{ method: 'text', value: 'Team member' }],
  };
  let prior = false;
  const client = {
    query: async (sql: string) => ({
      rows: sql.includes('assignments') ? [{ identity }] : [],
      rowCount: sql.includes('pr_commands') && prior ? 1 : 0,
    }),
  } as unknown as PoolClient;
  const definition = {
    ...task('prepare'),
    sessionPlan: { preparationMs: 120000, requirements: [] },
  };
  const context = {
    task_id: 'prepare',
    id: 'execution',
    definition,
    budget_state: null,
  } as unknown as ExecutionContext;
  const command = {
    type: 'browser.identity.prepare' as const,
    url: definition.target.url,
    profileRef: 'private',
    checks: identity.checks as [{ method: 'text'; value: string }],
    saveSnapshot: false,
  };
  assert.equal(await authorizePreparation(client, context, command), 120000);
  await assert.rejects(
    authorizePreparation(client, context, { ...command, profileRef: 'other' }),
    /绑定/,
  );
  await assert.rejects(
    authorizePreparation(client, context, { ...command, checks: [] }),
    /冻结条件/,
  );
  prior = true;
  await assert.rejects(
    authorizePreparation(client, context, command),
    /已尝试/,
  );
  prior = false;
  context.budget_state = {
    stepId: 'step-1',
    actions: 0,
    modelCalls: 0,
    deadlineAt: Date.now() + 10000,
    pausedAt: null,
  };
  await assert.rejects(
    authorizePreparation(client, context, command),
    /先于业务/,
  );
});

// 范围：身份准备增加会话总预算，不改变业务及清理预算；不模拟浏览器墙钟计时。
test('登录准备不挤占独立步骤和固定三分钟清理', () => {
  const definition = task('budget') as ExecutionContext['definition'];
  definition.steps = [
    {
      stepId: 'step-1',
      description: 'fixture',
      url: definition.target.url,
      expected: [],
      type: 'setup',
      exec_order: 1,
      policy: [],
    },
  ];
  definition.stepBudget = compileStepBudget(definition);
  const before = sessionBudgetMs(definition);
  definition.sessionPlan = {
    version: 1,
    mode: 'identity',
    candidates: [
      {
        id: 'fixture',
        label: 'fixture',
        accountKey: 'fixture',
        origins: ['https://example.test'],
        checks: [],
        maxConcurrent: 1,
      },
    ],
    requirements: [],
    preparationMs: 120000,
  };
  assert.equal(sessionBudgetMs(definition), before + 120000);
  assert.equal(definition.stepBudget.cleanup.timeoutMs, 180000);
  assert.equal(definition.stepBudget.steps[0]!.timeoutMs, 300000);
});
